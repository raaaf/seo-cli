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

process.env.ANTHROPIC_API_KEY = 'test-key';
const { complete } = await import('../src/lib/claude.js');
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
