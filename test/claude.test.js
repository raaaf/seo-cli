import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
const batchCreate = vi.fn();
const batchRetrieve = vi.fn();
const batchResults = vi.fn();
const batchCancel = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.messages = {
        create,
        batches: { create: batchCreate, retrieve: batchRetrieve, results: batchResults, cancel: batchCancel },
      };
    }
  },
}));

process.env.ANTHROPIC_API_KEY = 'test-key';
const { complete } = await import('../src/lib/claude.js');

const reply = (text) => ({ content: [{ type: 'text', text }] });

// Async iterable helper for batches.results().
function resultsOf(entries) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of entries) yield e; } };
}

beforeEach(() => {
  create.mockReset();
  batchCreate.mockReset();
  batchRetrieve.mockReset();
  batchResults.mockReset();
  batchCancel.mockReset();
});

describe('claude-complete', () => {
  it('returns trimmed text', async () => {
    create.mockResolvedValue(reply('  hello world  '));
    expect(await complete({ system: 's', prompt: 'p' })).toBe('hello world');
  });

  it('uses the shared default model when none is given', async () => {
    create.mockResolvedValue(reply('ok'));
    await complete({ system: 's', prompt: 'p' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
  });

  it('extracts JSON from a ```json fence', async () => {
    create.mockResolvedValue(reply('```json\n{"a":1}\n```'));
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ a: 1 });
  });

  it('extracts a bare JSON object', async () => {
    create.mockResolvedValue(reply('here you go {"b":2} done'));
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ b: 2 });
  });

  it('throws when no JSON is present', async () => {
    create.mockResolvedValue(reply('no json here'));
    await expect(complete({ system: 's', prompt: 'p', json: true })).rejects.toThrow(/no JSON/);
  });

  it('throws on malformed JSON', async () => {
    create.mockResolvedValue(reply('{ not: valid, }'));
    await expect(complete({ system: 's', prompt: 'p', json: true })).rejects.toThrow(/malformed JSON/);
  });

  it('rethrows a non-retryable error without retrying', async () => {
    // Guard against vitest's phantom no-arg probe call; only a real request throws.
    create.mockImplementation((req) => {
      if (req) throw Object.assign(new Error('bad request'), { status: 400 });
    });
    let caught;
    try { await complete({ system: 's', prompt: 'p' }); } catch (e) { caught = e; }
    expect(caught?.message).toBe('bad request');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('skips a leading thinking block to find the text block', async () => {
    create.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: '{"a":1}' },
      ],
    });
    expect(await complete({ system: 's', prompt: 'p', json: true })).toEqual({ a: 1 });
  });

  it('throws a descriptive error instead of crashing when there is no text block', async () => {
    create.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
    await expect(complete({ system: 's', prompt: 'p' })).rejects.toThrow(/max_tokens/);
  });

  it('batch success returns the batch result text and never calls messages.create', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'succeeded', message: { ...reply('batched text'), usage: { input_tokens: 10, output_tokens: 20 } } } },
    ]));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('batched text');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to the interactive request when the batch result errors', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_2', processing_status: 'ended' });
    batchRetrieve.mockResolvedValue({ processing_status: 'ended' });
    batchResults.mockResolvedValue(resultsOf([
      { custom_id: 'seo-1', result: { type: 'errored' } },
    ]));
    create.mockResolvedValue(reply('interactive fallback'));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('interactive fallback');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('cancels and falls back to interactive when the wait cap is reached', async () => {
    batchCreate.mockResolvedValue({ id: 'batch_3', processing_status: 'in_progress' });
    batchRetrieve.mockResolvedValue({ processing_status: 'in_progress' });
    create.mockResolvedValue(reply('interactive after timeout'));
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
    create.mockResolvedValue(reply('interactive after submit failure'));
    const text = await complete({ system: 's', prompt: 'p', batch: true, batchPollMs: 1 });
    expect(text).toBe('interactive after submit failure');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
