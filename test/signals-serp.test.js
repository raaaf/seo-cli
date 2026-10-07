import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir;
vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

async function freshModule() {
  vi.resetModules();
  const { safeFetch } = await import('../src/lib/safe-fetch.js');
  const serpapi = await import('../src/lib/serpapi.js');
  const serp = await import('../src/lib/signals/serp.js');
  return { serpapi, safeFetch, serp };
}

const respond = body => ({ ok: true, json: async () => body });
const searchCalls = safeFetch => safeFetch.mock.calls.filter(([u]) => String(u).includes('search.json'));
const cacheFile = () => join(dir, 'seo', 'signals', 'serp.json');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signals-serp-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  process.env.SERPAPI_KEY = 'k';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERPAPI_KEY;
});

describe('extractFeatures', () => {
  it('detects the AI Overview and a citation of our own domain', async () => {
    const { serp } = await freshModule();
    const f = serp.resolveFeatures(serp.extractFeatures({
      ai_overview: { text_blocks: [{}], references: [{ link: 'https://other.com/a' }, { link: 'https://blog.Example.de/x' }] },
      answer_box: { title: 't' }, local_results: { places: [1] }, shopping_results: [{}], inline_videos: [{}],
    }), 'https://www.example.de');
    expect(f).toEqual({ ai_overview: true, ai_overview_cites_us: true, answer_box: true, local_pack: true, shopping: true, videos: true });
  });

  it('matches the hostname, not a substring', async () => {
    const { serp } = await freshModule();
    const refs = [{ link: 'https://notexample.de/a' }, { link: 'https://other.com/example.de' }, { link: 'https://example.de.evil.com/' }];
    const stored = serp.extractFeatures({ ai_overview: { references: refs } });
    expect(serp.resolveFeatures(stored, 'https://example.de').ai_overview_cites_us).toBe(false);
  });

  it('is all false without ai_overview, and an errored overview does not count', async () => {
    const { serp } = await freshModule();
    const none = { ai_overview: false, ai_overview_cites_us: false, answer_box: false, local_pack: false, shopping: false, videos: false };
    const resolve = d => serp.resolveFeatures(serp.extractFeatures(d), 'https://example.de');
    expect(resolve({ organic_results: [] })).toEqual(none);
    expect(resolve({ ai_overview: { error: 'x' }, shopping_results: [] })).toEqual(none);
  });

  it('counts an overview that only carries a page_token, with cites_us unknown (null)', async () => {
    const { serp } = await freshModule();
    const f = serp.resolveFeatures(serp.extractFeatures({ ai_overview: { page_token: 't', serpapi_link: 'l' } }), 'https://example.de');
    expect(f.ai_overview).toBe(true);
    expect(f.ai_overview_cites_us).toBeNull();
  });

  it('keeps only lowercase hostnames, no links or text', async () => {
    const { serp } = await freshModule();
    const f = serp.extractFeatures({ ai_overview: { references: [{ link: 'https://WWW.Other.com/a?x=1', title: 'T' }, { link: 'https://other.com/b' }] } });
    expect(f.ai_overview_hosts).toEqual(['other.com']);
  });

  it('is null without a base_url, as there is nothing to compare against', async () => {
    const { serp } = await freshModule();
    const stored = serp.extractFeatures({ ai_overview: { references: [{ link: 'https://example.de/a' }] } });
    expect(serp.resolveFeatures(stored, null).ai_overview_cites_us).toBeNull();
  });
});

describe('serpKey', () => {
  it('trims, collapses whitespace and fills the default locale and gl', async () => {
    const { serp } = await freshModule();
    expect(serp.serpKey('  Foo   Bar ')).toBe('de:de:foo bar');
    expect(serp.serpKey('foo bar', null, '')).toBe('de:de:foo bar');
    expect(serp.serpKey('foo', 'en', 'us')).toBe('en:us:foo');
  });
});

describe('getSerp cache', () => {
  const body = { organic_results: [{ title: 'T', snippet: 'S' }], ai_overview: { references: [{ link: 'https://example.de/p' }], text_blocks: [{ snippet: 'SECRET TEXT' }] } };

  it('returns features, stores only extracted data, and a second call costs no search', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(respond(body));
    const first = await serpapi.getSerp('Kw', { baseUrl: 'https://example.de' });
    expect(first.features.ai_overview_cites_us).toBe(true);
    const second = await serpapi.getSerp('kw', { baseUrl: 'https://example.de' });
    expect(second).toEqual(first);
    expect(searchCalls(safeFetch)).toHaveLength(1);
    expect(readFileSync(cacheFile(), 'utf8')).not.toContain('SECRET TEXT');
  });

  it('applies the current base_url to a cached entry without a new search', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(respond(body));
    const wrong = await serpapi.getSerp('kw', { baseUrl: 'https://wrong.example' });
    const right = await serpapi.getSerp('kw', { baseUrl: 'https://example.de' });
    expect(wrong.features.ai_overview_cites_us).toBe(false);
    expect(right.features.ai_overview_cites_us).toBe(true);
    expect(searchCalls(safeFetch)).toHaveLength(1);
    expect(readFileSync(cacheFile(), 'utf8')).not.toContain('ai_overview_cites_us');
  });

  it('serves a hit before the key, budget and account checks', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(respond(body));
    await serpapi.getSerp('kw');
    safeFetch.mockClear();
    delete process.env.SERPAPI_KEY;
    await expect(serpapi.getSerp('kw')).resolves.toMatchObject({ top_titles: ['T'] });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('fetches again once the entry is older than 30 days', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(respond(body));
    await serpapi.getSerp('kw');
    const store = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    store.entries['de:de:kw'].fetched_at = new Date(Date.now() - 31 * 86400000).toISOString();
    writeFileSync(cacheFile(), JSON.stringify(store));
    await serpapi.getSerp('kw');
    expect(searchCalls(safeFetch)).toHaveLength(2);
  });

  it('ignores a cached entry of the wrong shape', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(respond(body));
    mkdirSync(join(dir, 'seo', 'signals'), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ version: 1, entries: { 'de:de:kw': { fetched_at: new Date().toISOString(), value: { top_titles: 'x' } } } }));
    const out = await serpapi.getSerp('kw');
    expect(out.top_titles).toEqual(['T']);
    expect(searchCalls(safeFetch)).toHaveLength(1);
  });
});
