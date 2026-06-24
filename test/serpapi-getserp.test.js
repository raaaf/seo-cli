import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mirrors serpapi.test.js setup: QUOTA_FILE is captured at module scope, so use a
// temp quota file + resetModules + dynamic import per case.
let dir;
vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

async function freshModule() {
  vi.resetModules();
  const safeFetchMod = await import('../src/lib/safe-fetch.js');
  const serpapi = await import('../src/lib/serpapi.js');
  return { serpapi, safeFetch: safeFetchMod.safeFetch };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'serpapi-parse-'));
  process.env.SEO_CLI_QUOTA_FILE = join(dir, 'quota.json');
  process.env.SERPAPI_KEY = 'test-key';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SEO_CLI_QUOTA_FILE;
  delete process.env.SERPAPI_KEY;
  vi.clearAllMocks();
});

describe('serpapi-getserp', () => {
  it('throws when SERPAPI_KEY is not set', async () => {
    delete process.env.SERPAPI_KEY;
    const { serpapi } = await freshModule();
    await expect(serpapi.getSerp('kw')).rejects.toThrow('SERPAPI_KEY not set');
  });

  it('parses titles, snippets, related searches and people-also-ask', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        organic_results: [
          { title: 'T1', snippet: 'S1' },
          { title: 'T2' }, // missing snippet -> filtered out of snippets
          { title: 'T3', snippet: 'S3' },
        ],
        related_searches: [{ query: 'r1' }, { query: 'r2' }],
        related_questions: [{ question: 'q1' }, { question: 'q2' }],
      }),
    });
    const out = await serpapi.getSerp('hochzeit planen', { locale: 'de' });
    expect(out.top_titles).toEqual(['T1', 'T2', 'T3']);
    expect(out.top_snippets).toEqual(['S1', 'S3']);
    expect(out.related_searches).toEqual(['r1', 'r2']);
    expect(out.people_also_ask).toEqual(['q1', 'q2']);
  });

  it('passes the locale through to the request URL', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue({ ok: true, json: async () => ({ organic_results: [] }) });
    await serpapi.getSerp('kw', { locale: 'en', gl: 'us' });
    const url = safeFetch.mock.calls[0][0];
    expect(url).toContain('hl=en');
    expect(url).toContain('gl=us');
    expect(url).toContain('q=kw');
  });
});
