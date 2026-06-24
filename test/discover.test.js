import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const querySearchAnalytics = vi.fn();
const getSerp = vi.fn();
const checkQuota = vi.fn(() => ({ used: 0, remaining: 240, month: '2026-06' }));
const complete = vi.fn();

vi.mock('../src/lib/gsc.js', () => ({ querySearchAnalytics: (...a) => querySearchAnalytics(...a) }));
vi.mock('../src/lib/serpapi.js', () => ({ getSerp: (...a) => getSerp(...a), checkQuota: (...a) => checkQuota(...a) }));
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { discover } = await import('../src/steps/discover.js');

const EMPTY_SERP = { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
const config = {
  gsc_property: 'sc-domain:acme.io', locale: 'de', score_cutoff: 7, weekly_cap: 1,
  min_impressions: 5, clusters: ['hochzeit'], landing_path: 'resources/landing/de/',
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-disc-'));
  for (const fn of [querySearchAnalytics, getSerp, complete]) fn.mockReset();
  getSerp.mockResolvedValue({ ...EMPTY_SERP });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('discover-run', () => {
  it('scores GSC candidates and proposes those above the cutoff', async () => {
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'hochzeit planen', impressions: 50, clicks: 0, ctr: 0, position: 12 },
    ]);
    complete.mockResolvedValue({
      score: 9, type: 'guide', intent: 'informational',
      target_slug: 'hochzeit-planen', expected_entities: ['standesamt'], content_gaps: [],
    });

    const data = await discover(config, dir);
    const kw = data.keywords.find(k => k.keyword === 'hochzeit planen');
    expect(kw).toMatchObject({ status: 'proposed', score: 9, target_slug: 'hochzeit-planen', source: 'gsc' });
    expect(complete).toHaveBeenCalledTimes(1); // scoring only, cap already filled
  });

  it('warns when the SerpAPI monthly quota is exhausted', async () => {
    checkQuota.mockReturnValueOnce({ used: 240, remaining: 0, month: '2026-06' });
    querySearchAnalytics.mockResolvedValue([]); // greenfield path
    complete.mockResolvedValue([]); // no suggestions
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    await discover(config, dir);
    spy.mockRestore();
    expect(logs.join('\n')).toMatch(/quota exhausted/i);
  });

  it('falls back to greenfield when GSC has no usable candidates', async () => {
    querySearchAnalytics.mockResolvedValue([]); // no candidates -> greenfield
    complete.mockResolvedValue([
      { keyword: 'standesamt deko', target_slug: 'standesamt-deko', score: 8, type: 'guide', intent: 'informational' },
    ]);

    const data = await discover(config, dir);
    const kw = data.keywords.find(k => k.keyword === 'standesamt deko');
    expect(kw).toMatchObject({ status: 'proposed', score: 8, source: 'greenfield' });
  });
});
