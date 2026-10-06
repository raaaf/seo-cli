import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stream = vi.fn();
const betaStream = vi.fn();
const batchCreate = vi.fn();
const batchRetrieve = vi.fn();
const batchResults = vi.fn();
const batchCancel = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.messages = {
        stream,
        batches: { create: batchCreate, retrieve: batchRetrieve, results: batchResults, cancel: batchCancel },
      };
      this.beta = { messages: { stream: betaStream } };
    }
  },
}));

// The subscription backend spawns `claude -p`: mocked at that boundary, the real
// ClaudeCodeError class stays.
const viaClaudeCode = vi.fn();
const claudeOnPath = vi.fn();
vi.mock('../src/lib/claude-code.js', async (orig) => ({
  ...(await orig()),
  completeViaClaudeCode: (...a) => viaClaudeCode(...a),
  claudeOnPath: () => claudeOnPath(),
}));

process.env.ANTHROPIC_API_KEY = 'test-key';
const { complete, getLlmStats, resetLlmState } = await import('../src/lib/claude.js');
const { ClaudeCodeError } = await import('../src/lib/claude-code.js');
const { MODELS } = await import('../src/lib/models.js');

const reply = (text) => ({ content: [{ type: 'text', text }] });

// The interactive path is `messages.stream(params).finalMessage()`; wrap a
// resolved message the way the SDK's MessageStream does.
const streamsTo = (res) => ({ finalMessage: () => Promise.resolve(res) });

// Async iterable helper for batches.results().
function resultsOf(entries) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of entries) yield e; } };
}

// complete() books into seo/budget.json under cwd, so cwd is a temp dir.
let dir;
const budgetOnDisk = () => JSON.parse(readFileSync(join(dir, 'seo', 'budget.json'), 'utf8')).anthropic;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  stream.mockReset();
  betaStream.mockReset();
  batchCreate.mockReset();
  batchRetrieve.mockReset();
  batchResults.mockReset();
  batchCancel.mockReset();
  viaClaudeCode.mockReset();
  claudeOnPath.mockReset();
  claudeOnPath.mockReturnValue(true);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.SEO_LLM_BACKEND;
  resetLlmState();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('claude-complete', () => {
  it('returns trimmed text', async () => {
    stream.mockReturnValue(streamsTo(reply('  hello world  ')));
    expect(await complete({ system: 's', prompt: 'p' })).toBe('hello world');
  });

  it('uses the shared default model when none is given', async () => {
    stream.mockReturnValue(streamsTo(reply('ok')));
    await complete({ system: 's', prompt: 'p' });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5' }));
  });

  it('calls messages.stream().finalMessage() on the interactive path, not messages.create', async () => {
    stream.mockReturnValue(streamsTo(reply('ok')));
    await complete({ system: 's', prompt: 'p' });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON from a ```json fence', async () => {
    stream.mockReturnValue(streamsTo(reply('```json\n{"a":1}\n```')));
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ a: 1 });
  });

  it('extracts a bare JSON object', async () => {
    stream.mockReturnValue(streamsTo(reply('here you go {"b":2} done')));
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ b: 2 });
  });

  it('throws when no JSON is present', async () => {
    stream.mockReturnValue(streamsTo(reply('no json here')));
    await expect(complete({ system: 's', prompt: 'p', json: true })).rejects.toThrow(/no JSON/);
  });

  it('throws on malformed JSON', async () => {
    stream.mockReturnValue(streamsTo(reply('{ not: valid, }')));
    await expect(complete({ system: 's', prompt: 'p', json: true })).rejects.toThrow(/malformed JSON/);
  });

  it('rethrows a non-retryable error without retrying', async () => {
    stream.mockReturnValue({ finalMessage: () => Promise.reject(Object.assign(new Error('bad request'), { status: 400 })) });
    let caught;
    try { await complete({ system: 's', prompt: 'p' }); } catch (e) { caught = e; }
    expect(caught?.message).toBe('bad request');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('skips a leading thinking block to find the text block', async () => {
    stream.mockReturnValue(streamsTo({
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: '{"a":1}' },
      ],
    }));
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ a: 1 });
  });

  it('throws a descriptive error instead of crashing when there is no text block', async () => {
    stream.mockReturnValue(streamsTo({ content: [], stop_reason: 'end_turn' }));
    await expect(complete({ system: 's', prompt: 'p' })).rejects.toThrow(/no text block/);
  });

  it('throws naming max_tokens and the usage when the interactive response was truncated', async () => {
    stream.mockReturnValue(streamsTo({
      content: [{ type: 'text', text: 'cut off half' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 4096 },
    }));
    await expect(complete({ system: 's', prompt: 'p', maxTokens: 4096 }))
      .rejects.toThrow(/max_tokens.*4096.*4096/s);
  });

  it('batch success returns the batch result text and never calls messages.stream', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'succeeded', message: { ...reply('batched text'), stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } } },
    ]));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('batched text');
    expect(stream).not.toHaveBeenCalled();
  });

  it('throws on a succeeded batch result that hit max_tokens, without falling back to the interactive request', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_max', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'succeeded', message: { ...reply('cut off'), stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 32000 } } } },
    ]));
    await expect(complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1, maxTokens: 32000 }))
      .rejects.toThrow(/max_tokens/);
    expect(stream).not.toHaveBeenCalled();
  });

  it('falls back to the interactive request when the batch result errors', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_2', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'errored' } },
    ]));
    stream.mockReturnValue(streamsTo(reply('interactive fallback')));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('interactive fallback');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('cancels and falls back to interactive when the wait cap is reached', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_3', processing_status: 'in_progress' });
    batchRetrieve.mockResolvedValue({ processing_status: 'in_progress' });
    stream.mockReturnValue(streamsTo(reply('interactive after timeout')));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchWaitMs: 0, batchPollMs: 1 });
    expect(text).toBe('interactive after timeout');
    expect(batchCancel).toHaveBeenCalledWith('batch_3');
    expect(batchResults).not.toHaveBeenCalled();
  });

  it('throws when batch and webSearch are combined', async () => {
    await expect(complete({ system: 's', prompt: 'p', batch: true, webSearch: true }))
      .rejects.toThrow(/batch and webSearch/);
    expect(batchCreate).not.toHaveBeenCalled();
  });

  it('falls back to interactive when batch submission itself throws', async () => {
    batchCreate.mockRejectedValue(new Error('quota exceeded'));
    stream.mockReturnValue(streamsTo(reply('interactive after submit failure')));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('interactive after submit failure');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('throws mentioning the refusal and stop_details category, and does not retry, on the interactive response', async () => {
    stream.mockReturnValue(streamsTo({
      content: [{ type: 'text', text: 'declined' }],
      stop_reason: 'refusal',
      stop_details: { category: 'bio' },
    }));
    await expect(complete({ system: 's', prompt: 'p' }))
      .rejects.toThrow(/refusal.*bio/s);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('throws on a refusal returned from a pause_turn resume, and does not retry', async () => {
    stream
      .mockReturnValueOnce(streamsTo({
        content: [{ type: 'text', text: 'searching...' }],
        stop_reason: 'pause_turn',
      }))
      .mockReturnValueOnce(streamsTo({
        content: [{ type: 'text', text: 'declined after resume' }],
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
      }));
    await expect(complete({ system: 's', prompt: 'p', webSearch: true }))
      .rejects.toThrow(/refusal.*cyber/s);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('routes a non-batch Opus call through the beta client with fallbacks and high effort', async () => {
    betaStream.mockReturnValue(streamsTo(reply('opus text')));
    const text = await complete({ system: 's', prompt: 'p', model: MODELS.generate });
    expect(text).toBe('opus text');
    expect(stream).not.toHaveBeenCalled();
    expect(betaStream).toHaveBeenCalledWith(expect.objectContaining({
      model: MODELS.generate,
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: expect.objectContaining({ effort: 'high' }),
    }));
  });

  it('does not carry fallbacks or effort for a Sonnet call', async () => {
    stream.mockReturnValue(streamsTo(reply('sonnet text')));
    await complete({ system: 's', prompt: 'p', model: MODELS.default });
    expect(betaStream).not.toHaveBeenCalled();
    const callArgs = stream.mock.calls[0][0];
    expect(callArgs.fallbacks).toBeUndefined();
    expect(callArgs.betas).toBeUndefined();
    expect(callArgs.output_config).toBeUndefined();
  });

  it('does not carry fallbacks for a batch Opus call, but still sends high effort', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_opus', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'succeeded', message: { ...reply('batched opus text'), stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } } },
    ]));
    const text = await complete({ system: 's', prompt: 'p', model: MODELS.generate, batch: true, batchPollMs: 1 });
    expect(text).toBe('batched opus text');
    expect(stream).not.toHaveBeenCalled();
    expect(betaStream).not.toHaveBeenCalled();
    const sentParams = batchCreate.mock.calls[0][0].requests[0].params;
    expect(sentParams.fallbacks).toBeUndefined();
    expect(sentParams.betas).toBeUndefined();
    expect(sentParams.output_config).toEqual({ effort: 'high' });
  });
});

describe('claude-budget', () => {
  const sonnet = (usage, extra = {}) => ({ ...reply('ok'), model: 'claude-sonnet-5-5', usage, ...extra });
  const month = new Date().toISOString().slice(0, 7);

  it('books an interactive call at the model price, cache tokens included', async () => {
    stream.mockReturnValue(streamsTo(sonnet({ input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })));
    await complete({ system: 's', prompt: 'p' });
    // 2 + 1 (output) + 2.5 + 0.2
    expect(budgetOnDisk().usd).toBeCloseTo(5.7, 6);
    expect(budgetOnDisk().calls).toBe(1);
  });

  it('prices by the model the server reports, not the requested one', async () => {
    betaStream.mockReturnValue(streamsTo(sonnet({ input_tokens: 1_000_000, output_tokens: 0 })));
    await complete({ system: 's', prompt: 'p', model: MODELS.generate }); // requested Opus, served Sonnet
    expect(budgetOnDisk().usd).toBeCloseTo(2, 6);
  });

  it('books every pause_turn continuation as its own response', async () => {
    stream.mockReturnValueOnce(streamsTo(sonnet({ input_tokens: 1_000_000, output_tokens: 0 }, { stop_reason: 'pause_turn' })))
      .mockReturnValueOnce(streamsTo(sonnet({ input_tokens: 1_000_000, output_tokens: 0 })));
    await complete({ system: 's', prompt: 'p', webSearch: true });
    expect(budgetOnDisk().usd).toBeCloseTo(4, 6);
    expect(budgetOnDisk().calls).toBe(2);
  });

  it('books a batch response at half price', async () => {
    batchCreate.mockResolvedValue({ id: 'b1', processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([{ custom_id: 'seo-1', result: { type: 'succeeded', message: sonnet({ input_tokens: 1_000_000, output_tokens: 1_000_000 }) } }]));
    await complete({ system: 's', prompt: 'p', batch: true });
    expect(budgetOnDisk().usd).toBeCloseTo(6, 6); // (2 + 10) * 0.5
  });

  it('adds 0.01 USD per web_search request', async () => {
    stream.mockReturnValue(streamsTo(sonnet({ input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } })));
    await complete({ system: 's', prompt: 'p', webSearch: true });
    expect(budgetOnDisk().usd).toBeCloseTo(0.03, 6);
  });

  it('books an unknown model at the most expensive known price and warns', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    stream.mockReturnValue(streamsTo({ ...reply('ok'), model: 'claude-future-9', usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
    await complete({ system: 's', prompt: 'p' });
    expect(budgetOnDisk().usd).toBeCloseTo(4, 6); // Opus input price
    expect(log.mock.calls.flat().join(' ')).toMatch(/Unknown model "claude-future-9"/);
  });

  it('refuses before the API call once the limit is reached', async () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo', 'budget.json'), JSON.stringify({ month, serpapi: { used: 0 }, anthropic: { usd: 30, calls: 9 } }));
    await expect(complete({ system: 's', prompt: 'p' })).rejects.toThrow(/Anthropic monthly budget exhausted/);
    expect(stream).not.toHaveBeenCalled();
    expect(batchCreate).not.toHaveBeenCalled();
  });
});

describe('claude-subscription-backend', () => {
  const ccOk = (extra = {}) => ({ text: 'cc answer', structured: null, costUsd: 0.5, ...extra });
  const bookedUsd = () => JSON.parse(readFileSync(join(dir, 'seo', 'budget.json'), 'utf8'));
  const call = (extra = {}) => complete({ system: 's', prompt: 'p', ...extra });
  const apiOk = () => stream.mockReturnValue(streamsTo(reply('api answer')));

  beforeEach(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('uses claude -p when the token is set', async () => {
    viaClaudeCode.mockResolvedValue(ccOk());
    expect(await call()).toBe('cc answer');
    expect(stream).not.toHaveBeenCalled();
  });

  it('uses the API without the token', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    apiOk();
    expect(await call()).toBe('api answer');
    expect(viaClaudeCode).not.toHaveBeenCalled();
  });

  it('forces the API with SEO_LLM_BACKEND=api or backend: api', async () => {
    apiOk();
    process.env.SEO_LLM_BACKEND = 'api';
    await call();
    delete process.env.SEO_LLM_BACKEND;
    await call({ backend: 'api' });
    expect(viaClaudeCode).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('falls back to the API with one warning when claude is not in PATH', async () => {
    claudeOnPath.mockReturnValue(false);
    apiOk();
    await call();
    await call();
    expect(viaClaudeCode).not.toHaveBeenCalled();
    expect(getLlmStats().fallbacks).toHaveLength(1);
  });

  it('falls back for one call on kind error, the next call uses the subscription again', async () => {
    viaClaudeCode.mockRejectedValueOnce(new ClaudeCodeError('boom', { kind: 'error' })).mockResolvedValue(ccOk());
    apiOk();
    expect(await call()).toBe('api answer');
    expect(await call()).toBe('cc answer');
    expect(getLlmStats().fallbacks).toEqual([{ model: MODELS.default, kind: 'error', reason: 'boom' }]);
  });

  it.each(['limit', 'auth', 'timeout'])('switches every model to the API for good after kind %s', async (kind) => {
    viaClaudeCode.mockRejectedValueOnce(new ClaudeCodeError('x', { kind }));
    apiOk();
    betaStream.mockReturnValue(streamsTo(reply('api answer')));
    await call();
    await call({ model: MODELS.generate });
    expect(viaClaudeCode).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(betaStream).toHaveBeenCalledTimes(1);
  });

  it('switches only the Opus family after an Opus limit', async () => {
    viaClaudeCode.mockRejectedValueOnce(new ClaudeCodeError('x', { kind: 'limit', family: 'opus' })).mockResolvedValue(ccOk());
    betaStream.mockReturnValue(streamsTo(reply('api answer')));
    expect(await call({ model: MODELS.generate })).toBe('api answer');
    expect(await call({ model: MODELS.generate })).toBe('api answer');
    expect(await call({ model: MODELS.default })).toBe('cc answer');
    expect(viaClaudeCode).toHaveBeenCalledTimes(2);
  });

  it('stays on the API after 60 minutes and runs the fallback without batch', async () => {
    const t0 = Date.now();
    resetLlmState();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 61 * 60 * 1000);
    apiOk();
    await call({ batch: true });
    expect(viaClaudeCode).not.toHaveBeenCalled();
    expect(batchCreate).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('still rejects batch together with web search when the token is set', async () => {
    await expect(call({ batch: true, webSearch: true })).rejects.toThrow(/cannot be combined/);
    expect(viaClaudeCode).not.toHaveBeenCalled();
  });

  it('books a subscription call under subscription, not anthropic', async () => {
    viaClaudeCode.mockResolvedValue(ccOk({ costUsd: 0.75 }));
    await call();
    const stored = bookedUsd();
    expect(stored.subscription).toEqual({ calls: 1, usd_equivalent: 0.75 });
    expect(stored.anthropic).toEqual({ usd: 0, calls: 0 });
  });

  it('counts both paths and the fallbacks in getLlmStats', async () => {
    viaClaudeCode.mockResolvedValueOnce(ccOk({ costUsd: 1 })).mockRejectedValueOnce(new ClaudeCodeError('lim', { kind: 'limit' }));
    apiOk();
    await call();
    await call();
    expect(getLlmStats()).toEqual({
      subscription_calls: 1, api_calls: 1, usd_equivalent: 1,
      fallbacks: [{ model: MODELS.default, kind: 'limit', reason: 'lim' }],
    });
  });

  it('prints a GitHub Actions warning per fallback', async () => {
    viaClaudeCode.mockRejectedValueOnce(new ClaudeCodeError('x', { kind: 'auth' }));
    apiOk();
    await call();
    expect(console.log.mock.calls.flat().join('\n')).toContain('::warning::seo-cli fell back to the API (auth)');
  });

  it('returns structured_output for a schema call', async () => {
    viaClaudeCode.mockResolvedValue(ccOk({ structured: { count: 3 } }));
    expect(await call({ json: true, schema: { type: 'object' } })).toEqual({ count: 3 });
    expect(viaClaudeCode.mock.calls[0][0].schema).toEqual({ type: 'object' });
  });

  it('extracts JSON from the subscription text', async () => {
    viaClaudeCode.mockResolvedValue(ccOk({ text: '```json\n{"a":1}\n```' }));
    expect(await call({ json: true })).toEqual({ a: 1 });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['no braces here', '{ not json }'])('falls back to the API for one call when the subscription text has unusable JSON (%s)', async (text) => {
    viaClaudeCode.mockResolvedValue(ccOk({ text }));
    stream.mockReturnValue(streamsTo(reply('{"a":2}')));
    expect(await call({ json: true })).toEqual({ a: 2 });
    const { fallbacks } = getLlmStats();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^Claude returned (no|malformed) JSON/) });
  });

  it('still throws when booking the subscription usage fails (fail closed)', async () => {
    viaClaudeCode.mockResolvedValue(ccOk());
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo', 'budget.json'), '{ not json');
    await expect(call()).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });

  it('runs the API call after a failed subscription attempt without batch', async () => {
    viaClaudeCode.mockRejectedValue(new ClaudeCodeError('boom', { kind: 'error' }));
    apiOk();
    expect(await call({ batch: true })).toBe('api answer');
    expect(batchCreate).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the API when the CLI reports max_tokens or a refusal', async () => {
    viaClaudeCode.mockRejectedValue(new Error('Claude hit stop_reason: max_tokens (limit 1, used 1 output tokens)'));
    await expect(call()).rejects.toThrow(/max_tokens/);
    expect(stream).not.toHaveBeenCalled();
    expect(getLlmStats().fallbacks).toEqual([]);
  });

  it('checks for the claude binary once per process', async () => {
    viaClaudeCode.mockResolvedValue(ccOk());
    await call();
    await call();
    expect(claudeOnPath).toHaveBeenCalledTimes(1);
  });
});
