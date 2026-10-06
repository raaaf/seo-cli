import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { MODELS, PRICES, BATCH_DISCOUNT, WEB_SEARCH_USD } from './models.js';
import { assertBudget, addAnthropicCost, addSubscriptionUsage } from './budget.js';
import { completeViaClaudeCode, claudeOnPath, ClaudeCodeError, assertNotTruncated, assertNotRefused } from './claude-code.js';

const MAX_RETRIES = 4;
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

// Exported so tests can shrink it instead of waiting on a real 30s interval.
export const BATCH_POLL_MS = 30000;

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// Server-side web search. Runs on Anthropic's side, so a single request returns
// the searched-and-answered result: no client tool loop, only pause_turn resumes.
const WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search_20260209', name: 'web_search' });
const MAX_PAUSE_RESUMES = 3;

// Opus 5.5 runs broader safety classifiers (bio, reasoning_extraction, on top
// of cyber) than Opus 5 and can decline a request with stop_reason: "refusal".
// Ship the fallback opt-in so a decline recovers instead of failing the
// pipeline outright. Scalar form: Anthropic picks the fallback model by refusal
// category. The SDK passes the body through untyped, so its typings do not
// matter here. The beta header must pair with the form (the array form needs
// -2026-06-01, the scalar one -2026-07-01, a mismatch is a 400). Not available
// on the Batches API, so only the interactive path below uses it.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = 'default';

// Builds the params object shared by the interactive request, its pause_turn
// resume, and the batch request.
function buildParams({ model, maxTokens, system, messages, thinking, outputConfig, tools }) {
  return {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? outputConfig : {}),
    ...(tools ? { tools } : {}),
  };
}

// Opus is the most expensive known model, so an id missing from PRICES is
// booked at its rates: the budget errs towards stopping early, not late.
const FALLBACK_PRICE = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

// Books the cost of one API response against the project budget. Priced by the
// model the server reports in res.model, not the requested one: the server-side
// fallback (FALLBACK_MODELS) can bill a different model than was asked for.
function recordUsage(res, { requestedModel, batch = false }) {
  const model = res.model ?? requestedModel;
  let price = PRICES[model];
  if (!price) {
    console.log(chalk.yellow(`  Unknown model "${model}", booking at the most expensive known price`));
    price = FALLBACK_PRICE;
  }
  const u = res.usage ?? {};
  const tokensUsd = (
    (u.input_tokens ?? 0) * price.input
    + (u.cache_creation_input_tokens ?? 0) * price.cacheWrite
    + (u.cache_read_input_tokens ?? 0) * price.cacheRead
    + (u.output_tokens ?? 0) * price.output
  ) / 1e6 * (batch ? BATCH_DISCOUNT : 1);
  const searchUsd = (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  addAnthropicCost(tokensUsd + searchUsd);
}

// One interactive request: budget check before, booking after (also when the
// response is truncated or refused, the tokens were spent either way).
async function streamMessage(params, { useFallback, requestedModel }) {
  assertBudget('anthropic');
  const client = useFallback ? getClient().beta.messages : getClient().messages;
  const streamParams = useFallback ? { ...params, fallbacks: FALLBACK_MODELS, betas: [FALLBACK_BETA] } : params;
  const res = await client.stream(streamParams).finalMessage();
  recordUsage(res, { requestedModel });
  return res;
}

// Submits a single-request batch and polls until it ends or the wait cap is
// reached. Returns the batch result message on success, or null when the
// caller should fall back to the interactive request (submission failure,
// non-succeeded result, or wait cap reached). A succeeded result is returned
// even when it hit max_tokens (not null): the caller's assertNotTruncated
// throws on it, rather than a retry falling back to the interactive request
// and truncating the exact same way on the exact same params.
async function runBatch(params, batchWaitMs, batchPollMs) {
  let batch;
  try {
    batch = await getClient().messages.batches.create({
      requests: [{ custom_id: 'seo-1', params }],
    });
  } catch (e) {
    console.log(chalk.yellow(`  Batch submission failed (${e.message}), falling back to the interactive request`));
    return null;
  }

  console.log(chalk.blue(`  Batch ${batch.id} submitted, waiting up to ${Math.round(batchWaitMs / 60000)} min ...`));

  const deadline = Date.now() + batchWaitMs;
  let status = batch.processing_status;
  while (status !== 'ended' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, batchPollMs));
    ({ processing_status: status } = await getClient().messages.batches.retrieve(batch.id));
  }

  if (status !== 'ended') {
    try { await getClient().messages.batches.cancel(batch.id); } catch { /* ignore */ }
    console.log(chalk.yellow(`  Batch ${batch.id} not finished after ${Math.round(batchWaitMs / 60000)} min, falling back to the interactive request`));
    return null;
  }

  for await (const r of await getClient().messages.batches.results(batch.id)) {
    if (r.custom_id !== 'seo-1') continue;
    if (r.result.type === 'succeeded') {
      const { usage, stop_reason } = r.result.message;
      console.log(chalk.green(`  Batch ${batch.id} succeeded (${usage.input_tokens} in / ${usage.output_tokens} out tokens, stop_reason: ${stop_reason})`));
      return r.result.message;
    }
    console.log(chalk.yellow(`  Batch ${batch.id} result: ${r.result.type}, falling back to the interactive request`));
    return null;
  }

  return null;
}

// Subscription backend state, per process. A limit, auth error or timeout
// switches every model to the API for good; an Opus or Sonnet limit only that
// family. After SUBSCRIPTION_WINDOW_MS the run stays on the API so the job
// finishes inside the workflow's timeout-minutes (120).
const SUBSCRIPTION_WINDOW_MS = 60 * 60 * 1000;
let startedAt = Date.now();
let switchedAll = false;
let switchedFamilies = new Set();
let missingCliWarned = false;
let cliOnPath = null;
let stats = { subscription_calls: 0, api_calls: 0, usd_equivalent: 0, fallbacks: [] };

export function resetLlmState() {
  startedAt = Date.now();
  switchedAll = false;
  switchedFamilies = new Set();
  missingCliWarned = false;
  cliOnPath = null;
  stats = { subscription_calls: 0, api_calls: 0, usd_equivalent: 0, fallbacks: [] };
}

export function getLlmStats() {
  return { ...stats, fallbacks: [...stats.fallbacks] };
}

function modelFamily(model) {
  if (/opus/i.test(model)) return 'opus';
  if (/sonnet/i.test(model)) return 'sonnet';
  return null;
}

// Every fallback is booked once and printed as a GitHub Actions annotation.
function noteFallback(model, kind, reason) {
  stats.fallbacks.push({ model, kind, reason });
  console.log(`::warning::seo-cli fell back to the API (${kind})`);
}

// Shared by both backends. The error messages are matched by regex in
// steps/review.js (isNoJsonError), keep them stable.
function extractJson(text) {
  const match = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
  if (!match) throw new Error(`Claude returned no JSON:\n${text.slice(0, 300)}`);
  try {
    return JSON.parse(match[1]);
  } catch (parseErr) {
    throw new Error(`Claude returned malformed JSON: ${parseErr.message}\n${match[1].slice(0, 300)}`, { cause: parseErr });
  }
}

export async function complete({
  system, prompt, model = MODELS.default, maxTokens = 4096, json = false, schema = null,
  webSearch = false, maxSearches = 6, batch = false, batchWaitMs = 45 * 60 * 1000, batchPollMs = BATCH_POLL_MS,
  backend = null,
}) {
  if (batch && webSearch) {
    throw new Error('complete(): batch and webSearch cannot be combined, a batch cannot resume a pause_turn.');
  }

  const family = modelFamily(model);
  const wantsSubscription = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
    && process.env.SEO_LLM_BACKEND !== 'api' && backend !== 'api';
  const windowOpen = Date.now() - startedAt < SUBSCRIPTION_WINDOW_MS;
  const switched = switchedAll || (family !== null && switchedFamilies.has(family));
  // Past the window an API fallback must not wait on a batch for 45 minutes.
  if (wantsSubscription && !windowOpen) batch = false;

  if (wantsSubscription && windowOpen && !switched) {
    cliOnPath ??= claudeOnPath();
    if (!cliOnPath) {
      if (!missingCliWarned) {
        missingCliWarned = true;
        noteFallback(model, 'error', 'claude not found in PATH');
      }
    } else {
      try {
        const res = await completeViaClaudeCode({ system, prompt, model, maxTokens, schema: json && schema ? schema : null, webSearch, maxSearches });
        addSubscriptionUsage(res.costUsd);
        stats.subscription_calls += 1;
        stats.usd_equivalent += res.costUsd;
        if (json && schema) return res.structured;
        if (!json) return res.text;
        // Unusable JSON from the CLI is a per-call fallback, like any other
        // subscription failure. Booking above stays outside this conversion.
        try { return extractJson(res.text); } catch (jsonErr) { throw new ClaudeCodeError(jsonErr.message); }
      } catch (e) {
        if (!(e instanceof ClaudeCodeError)) throw e;
        if (e.kind === 'limit' && e.family) switchedFamilies.add(e.family);
        else if (e.kind !== 'error') switchedAll = true;
        noteFallback(model, e.kind, e.message);
        // A batch can wait up to 45 minutes, too long on top of a failed attempt
        // inside the workflow's 120 minute timeout.
        batch = false;
      }
    }
  }

  const messages = [{ role: 'user', content: prompt }];
  const tools = webSearch ? [{ ...WEB_SEARCH_TOOL, max_uses: maxSearches }] : undefined;
  // Set explicitly rather than relying on the model default: the
  // generation/review/improve/counterpart routes are judgment-heavy and
  // should think, whichever model MODELS.generate points at.
  const thinking = model === MODELS.generate ? { type: 'adaptive' } : undefined;
  const useFallback = model === MODELS.generate && !batch;
  // Structured Outputs are incompatible with citations, so callers that use
  // web search (and therefore citations) must not pass a schema. Opus 5.5's
  // default effort is `medium` (Opus 5's was `high`); set it explicitly so
  // these judgment-heavy routes keep running at the effort they were tuned
  // at — Sonnet already defaults to `high` and is left unset.
  const outputConfigFields = {
    ...(model === MODELS.generate ? { effort: 'high' } : {}),
    ...(json && schema ? { format: { type: 'json_schema', schema } } : {}),
  };
  const outputConfig = Object.keys(outputConfigFields).length ? { output_config: outputConfigFields } : undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const params = buildParams({ model, maxTokens, system, messages, thinking, outputConfig, tools });

      let res = null;
      if (batch) {
        assertBudget('anthropic');
        res = await runBatch(params, batchWaitMs, batchPollMs);
        if (res) recordUsage(res, { requestedModel: model, batch: true });
      }
      // Streamed rather than a plain create(): a 32000-max_tokens request
      // (raised from 8000 so adaptive thinking has room, see models.js)
      // risks hitting the SDK's HTTP timeout on a non-streaming call.
      res ??= await streamMessage(params, { useFallback, requestedModel: model });
      assertNotTruncated(res, maxTokens);
      assertNotRefused(res);

      // The server-side search loop caps out at 10 iterations and returns
      // stop_reason "pause_turn"; resending the assistant turn resumes it.
      for (let resume = 0; res.stop_reason === 'pause_turn' && resume < MAX_PAUSE_RESUMES; resume++) {
        const resumeParams = buildParams({ model, maxTokens, system, messages: [...messages, { role: 'assistant', content: res.content }], thinking, outputConfig, tools });
        res = await streamMessage(resumeParams, { useFallback, requestedModel: model });
        assertNotTruncated(res, maxTokens);
        assertNotRefused(res);
      }

      // With web search the answer is the LAST text block: earlier ones narrate
      // the searches. Without tools there is only one.
      const textBlocks = res.content.filter((b) => b.type === 'text');
      const textBlock = textBlocks[textBlocks.length - 1];
      if (!textBlock) throw new Error(`Claude returned no text block (stop_reason: ${res.stop_reason})`);
      const text = textBlock.text.trim();
      stats.api_calls += 1;

      if (json && schema) {
        // Structured Outputs guarantee schema-conformant JSON, no extraction needed.
        return JSON.parse(text);
      }

      return json ? extractJson(text) : text;
    } catch (e) {
      const retryable = e.status === 529 || e.status === 503 || e.status === 502;
      if (!retryable || attempt === MAX_RETRIES) throw e;
      const exp = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
      const jitter = Math.floor(Math.random() * 1000);
      const wait = exp + jitter;
      console.log(chalk.yellow(`  Claude ${e.status} (overloaded) — retrying in ${(wait / 1000).toFixed(1)}s...`));
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
