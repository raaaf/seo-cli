import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const querySearchAnalytics = vi.fn();
const queryPagePerformance = vi.fn(() => Promise.resolve([]));
const getSerp = vi.fn();
const checkQuota = vi.fn(() => ({ used: 0, remaining: 240, month: '2026-06' }));
const complete = vi.fn();

vi.mock('../src/lib/gsc.js', () => ({
  querySearchAnalytics: (...a) => querySearchAnalytics(...a),
  queryPagePerformance: (...a) => queryPagePerformance(...a),
}));
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
  queryPagePerformance.mockReset();
  queryPagePerformance.mockResolvedValue([]);
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

  it('narrows the GSC query to the project base_url so sibling subdomains do not fill the row limit', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    complete.mockResolvedValue([]);

    await discover({ ...config, base_url: 'https://acme.io' }, dir);

    expect(querySearchAnalytics).toHaveBeenCalledWith('sc-domain:acme.io', { pageFilter: 'https://acme.io' });
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

  it('falls back to greenfield when GSC has no usable candidates and greenfield is enabled', async () => {
    querySearchAnalytics.mockResolvedValue([]); // no candidates -> greenfield
    complete.mockResolvedValue([
      { keyword: 'standesamt deko', target_slug: 'standesamt-deko', score: 8, type: 'guide', intent: 'informational' },
    ]);

    const data = await discover({ ...config, greenfield: true }, dir);
    const kw = data.keywords.find(k => k.keyword === 'standesamt deko');
    expect(kw).toMatchObject({ status: 'proposed', score: 8, source: 'greenfield' });
  });

  it('proposes nothing when GSC is empty and greenfield is off', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    const data = await discover(config, dir);
    expect(complete).not.toHaveBeenCalled();
    expect(data.keywords).toHaveLength(0);
  });

  it('skips a keyword that is only a word-order variant of an existing one', async () => {
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'hochzeit planen', impressions: 50, clicks: 0, ctr: 0, position: 12 },
    ]);
    complete.mockResolvedValue({
      score: 9, type: 'guide', intent: 'informational',
      target_slug: 'hochzeit-planen', expected_entities: [], content_gaps: [],
    });
    await discover(config, dir);

    complete.mockClear();
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'planen hochzeit', impressions: 40, clicks: 0, ctr: 0, position: 14 },
    ]);
    const data = await discover(config, dir);

    expect(complete).not.toHaveBeenCalled();
    const variant = data.keywords.find(k => k.keyword === 'planen hochzeit');
    expect(variant).toMatchObject({ status: 'skip', score: 0 });
    expect(variant.note).toMatch(/word-order variant/i);
  });

  it('skips a keyword whose query two of our own pages already contest', async () => {
    mkdirSync(join(dir, config.landing_path), { recursive: true });
    for (const slug of ['firmenfeier-planen', 'betriebsausflug-planen']) {
      writeFileSync(join(dir, config.landing_path, `${slug}.md`), '---\nslug: x\n---\n');
    }
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'betriebsfeier organisieren', impressions: 31, clicks: 0, ctr: 0, position: 20 },
    ]);
    queryPagePerformance.mockResolvedValue([
      { keys: ['https://acme.io/firmenfeier-planen', 'betriebsfeier organisieren'], impressions: 15, position: 66.7 },
      { keys: ['https://acme.io/betriebsausflug-planen', 'betriebsfeier organisieren'], impressions: 5, position: 89.6 },
    ]);

    const data = await discover({ ...config, base_url: 'https://acme.io' }, dir);

    expect(getSerp).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const kw = data.keywords.find(k => k.keyword === 'betriebsfeier organisieren');
    expect(kw).toMatchObject({ status: 'skip', score: 0 });
    expect(kw.note).toMatch(/contested by own pages/i);
  });

  it('still proposes a keyword when only one page ranks for it', async () => {
    mkdirSync(join(dir, config.landing_path), { recursive: true });
    writeFileSync(join(dir, config.landing_path, 'firmenfeier-planen.md'), '---\nslug: x\n---\n');
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'sommerfest organisieren', impressions: 31, clicks: 0, ctr: 0, position: 20 },
    ]);
    queryPagePerformance.mockResolvedValue([
      { keys: ['https://acme.io/firmenfeier-planen', 'sommerfest organisieren'], impressions: 15, position: 40 },
    ]);
    complete.mockResolvedValue({
      score: 8, type: 'guide', intent: 'informational',
      target_slug: 'sommerfest-organisieren', expected_entities: [], content_gaps: [],
    });

    const data = await discover({ ...config, base_url: 'https://acme.io' }, dir);

    expect(data.keywords.find(k => k.keyword === 'sommerfest organisieren')).toMatchObject({ status: 'proposed', score: 8 });
  });

  it('skips a keyword the model reports as already covered', async () => {
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'trauung im freien', impressions: 30, clicks: 0, ctr: 0, position: 11 },
    ]);
    complete.mockResolvedValue({ score: 0, covered_by: 'hochzeit-planen' });

    const data = await discover(config, dir);
    const kw = data.keywords.find(k => k.keyword === 'trauung im freien');
    expect(kw).toMatchObject({ status: 'skip', score: 0 });
    expect(kw.note).toMatch(/hochzeit-planen/);
  });
});
