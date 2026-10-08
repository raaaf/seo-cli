import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const api = { getUserSites: vi.fn(), getQueryStats: vi.fn() };
vi.mock('../src/lib/bing.js', async (orig) => ({ ...(await orig()), getUserSites: (...a) => api.getUserSites(...a), getQueryStats: (...a) => api.getQueryStats(...a) }));

const { refreshBingQueries, readBingQueries, bingCandidates } = await import('../src/lib/signals/bing.js');
const { putSignal } = await import('../src/lib/signals/store.js');

const config = { base_url: 'https://x.de', bing: { enabled: true } };
const now = new Date('2026-10-08T00:00:00Z');
const stat = { Query: 'Wie geht das', Impressions: 9, Clicks: 1, AvgImpressionPosition: 4, Date: `/Date(${now.getTime() - 86400000})/` };
let dir;
let warnings;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-bing-'));
  warnings = [];
  process.env.BING_WEBMASTER_KEY = 'k';
  api.getUserSites.mockReset().mockResolvedValue([{ Url: 'https://x.de/' }]);
  api.getQueryStats.mockReset().mockResolvedValue([stat, { ...stat, Query: 'mail a@b.de' }]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.BING_WEBMASTER_KEY; });

describe('refreshBingQueries', () => {
  it('stores the filtered, aggregated queries under the site key', async () => {
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    expect(readBingQueries(config, dir)).toEqual([{ query: 'wie geht das', impressions: 9, clicks: 1, position: 4 }]);
  });

  it('does not call Bing while the entry is fresh', async () => {
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    expect(api.getQueryStats).toHaveBeenCalledTimes(1);
  });

  it('does nothing without bing.enabled', async () => {
    await refreshBingQueries({ config: { ...config, bing: { enabled: false } }, cwd: dir, warnings, now });
    expect(api.getUserSites).not.toHaveBeenCalled();
    expect(readBingQueries({ ...config, bing: { enabled: false } }, dir)).toEqual([]);
  });

  it('warns without a key and calls nothing', async () => {
    delete process.env.BING_WEBMASTER_KEY;
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    expect(warnings).toHaveLength(1);
    expect(api.getUserSites).not.toHaveBeenCalled();
  });

  it('warns when Bing does not know the site', async () => {
    api.getUserSites.mockResolvedValue([{ Url: 'https://other.de/' }]);
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    expect(warnings).toHaveLength(1);
    expect(api.getQueryStats).not.toHaveBeenCalled();
  });

  it('turns a Bing error into a warning', async () => {
    api.getQueryStats.mockRejectedValue(new Error('Bing GetQueryStats failed (unavailable)'));
    await refreshBingQueries({ config, cwd: dir, warnings, now });
    expect(warnings).toEqual(['Bing queries not refreshed: Bing GetQueryStats failed (unavailable)']);
  });
});

describe('readBingQueries', () => {
  it('ignores an expired entry', () => {
    putSignal('bing', 'queries:https://x.de/', [{ query: 'a', impressions: 1, clicks: 0, position: 1 }], new Date(now.getTime() - 8 * 86400000), { cwd: dir });
    expect(readBingQueries(config, dir)).toEqual([]);
  });
});

describe('bingCandidates', () => {
  const q = (query, impressions, position) => ({ query, impressions, clicks: 0, position });
  it('keeps position 8 to 25 with at least max(5, min_impressions) impressions, as GSC-shaped rows', () => {
    const queries = [q('a', 5, 20), q('b', 4, 10), q('c', 50, 26), q('d', 8, 8), q('e', 50, 7)];
    expect(bingCandidates(queries, { min_impressions: 5 }).map(r => r.keyword)).toEqual(['d', 'a']);
    expect(bingCandidates(queries, { min_impressions: 8 }).map(r => r.keyword)).toEqual(['d']);
  });
});
