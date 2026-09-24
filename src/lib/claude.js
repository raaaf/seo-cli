import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { MODELS } from './models.js';

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
// Ship the fallback opt-in so a decline recovers on Opus 5 instead of failing
// the pipeline outright. Beta, array form (fallbacks: "default" isn't typed in
// the installed SDK yet) — not available on the Batches API, so only the
// interactive path below uses it.
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const FALLBACK_MODELS = Object.freeze([{ model: 'claude-opus-5' }]);

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

// A message that hit the max_tokens cap is not usable output, whether or not
// it happened to contain a text block: on 2026-09-23 adaptive thinking spent
// most or all of an 8000-token budget, leaving generate.js and improve.js
// truncated markdown or none at all. Fail loudly here instead of letting
// runBatch log "succeeded" or validate.js discover it downstream.
function assertNotTruncated(res, maxTokens) {
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`Claude hit stop_reason: max_tokens (limit ${maxTokens}, used ${res.usage?.output_tokens} output tokens)`);
  }
}

// A classifier decline is a normal HTTP 200 with stop_reason: "refusal", not
// an exception — surface it as one so callers don't treat empty/partial
// content as a successful generation.
function assertNotRefused(res) {
  if (res.stop_reason === 'refusal') {
    const category = res.stop_details?.category ?? 'unknown';
    throw new Error(`Claude declined the request (stop_reason: refusal, category: ${category})`);
  }
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

export async function complete({
  system, prompt, model = MODELS.default, maxTokens = 4096, json = false, schema = null,
  webSearch = false, maxSearches = 6, batch = false, batchWaitMs = 45 * 60 * 1000, batchPollMs = BATCH_POLL_MS,
}) {
  if (batch && webSearch) {
    throw new Error('complete(): batch and webSearch cannot be combined, a batch cannot resume a pause_turn.');
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

      let res = batch ? await runBatch(params, batchWaitMs, batchPollMs) : null;
      if (!res) {
        // Streamed rather than a plain create(): a 32000-max_tokens request
        // (raised from 8000 so adaptive thinking has room, see models.js)
        // risks hitting the SDK's HTTP timeout on a non-streaming call.
        const client = useFallback ? getClient().beta.messages : getClient().messages;
        const streamParams = useFallback ? { ...params, fallbacks: FALLBACK_MODELS, betas: [FALLBACK_BETA] } : params;
        res = await client.stream(streamParams).finalMessage();
      }
      assertNotTruncated(res, maxTokens);
      assertNotRefused(res);

      // The server-side search loop caps out at 10 iterations and returns
      // stop_reason "pause_turn"; resending the assistant turn resumes it.
      for (let resume = 0; res.stop_reason === 'pause_turn' && resume < MAX_PAUSE_RESUMES; resume++) {
        const resumeParams = buildParams({ model, maxTokens, system, messages: [...messages, { role: 'assistant', content: res.content }], thinking, outputConfig, tools });
        const client = useFallback ? getClient().beta.messages : getClient().messages;
        const streamParams = useFallback ? { ...resumeParams, fallbacks: FALLBACK_MODELS, betas: [FALLBACK_BETA] } : resumeParams;
        res = await client.stream(streamParams).finalMessage();
        assertNotTruncated(res, maxTokens);
        assertNotRefused(res);
      }

      // With web search the answer is the LAST text block: earlier ones narrate
      // the searches. Without tools there is only one.
      const textBlocks = res.content.filter((b) => b.type === 'text');
      const textBlock = textBlocks[textBlocks.length - 1];
      if (!textBlock) throw new Error(`Claude returned no text block (stop_reason: ${res.stop_reason})`);
      const text = textBlock.text.trim();

      if (json && schema) {
        // Structured Outputs guarantee schema-conformant JSON, no extraction needed.
        return JSON.parse(text);
      }

      if (json) {
        const match = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/);
        if (!match) throw new Error(`Claude returned no JSON:\n${text.slice(0, 300)}`);
        try {
          return JSON.parse(match[1]);
        } catch (parseErr) {
          throw new Error(`Claude returned malformed JSON: ${parseErr.message}\n${match[1].slice(0, 300)}`, { cause: parseErr });
        }
      }

      return text;
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
