import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() { this.messages = { create }; }
  },
}));

process.env.ANTHROPIC_API_KEY = 'test-key';
const { complete } = await import('../src/lib/claude.js');

const reply = (text) => ({ content: [{ text }] });

beforeEach(() => create.mockReset());

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
});
