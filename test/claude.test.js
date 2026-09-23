import { describe, it, expect, vi, beforeEach } from 'vitest';

const stream = vi.fn();
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
    }
  },
}));

process.env.ANTHROPIC_API_KEY = 'test-key';
const { complete } = await import('../src/lib/claude.js');

const reply = (text) => ({ content: [{ type: 'text', text }] });

// The interactive path is `messages.stream(params).finalMessage()`; wrap a
// resolved message the way the SDK's MessageStream does.
const streamsTo = (res) => ({ finalMessage: () => Promise.resolve(res) });

// Async iterable helper for batches.results().
function resultsOf(entries) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of entries) yield e; } };
}

beforeEach(() => {
  stream.mockReset();
  batchCreate.mockReset();
  batchRetrieve.mockReset();
  batchResults.mockReset();
  batchCancel.mockReset();
});

describe('claude-complete', () => {
  it('returns trimmed text', async () => {
    stream.mockReturnValue(streamsTo(reply('  hello world  ')));
    expect(await complete({ system: 's', prompt: 'p' })).toBe('hello world');
  });

  it('uses the shared default model when none is given', async () => {
    stream.mockReturnValue(streamsTo(reply('ok')));
    await complete({ system: 's', prompt: 'p' });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
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
});
