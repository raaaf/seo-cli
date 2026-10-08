import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const querySearchAnalytics = vi.fn();
const queryPagePerformance = vi.fn(() => Promise.resolve([]));
const getSerp = vi.fn();
const checkQuota = vi.fn(() => ({ used: 0, remaining: 60, limit: 60, month: '2026-06' }));
const complete = vi.fn();

vi.mock('../src/lib/gsc.js', () => ({
  querySearchAnalytics: (...a) => querySearchAnalytics(...a),
  queryPagePerformance: (...a) => queryPagePerformance(...a),
}));
vi.mock('../src/lib/serpapi.js', () => ({ getSerp: (...a) => getSerp(...a), checkQuota: (...a) => checkQuota(...a) }));
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { discover } = await import('../src/steps/discover.js');
const { BudgetExceededError } = await import('../src/lib/budget.js');
const { makeCatalog } = await import('./helpers/catalog.js');
const { putSignal } = await import('../src/lib/signals/store.js');

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

  it('stores the SERP features on the keyword, gives the model the present ones and passes base_url', async () => {
    const features = { ai_overview: true, ai_overview_cites_us: false, answer_box: false, local_pack: false, shopping: false, videos: true };
    getSerp.mockResolvedValue({ ...EMPTY_SERP, features });
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'hochzeit planen', impressions: 50, clicks: 0, ctr: 0, position: 12 },
    ]);
    complete.mockResolvedValue({
      score: 9, type: 'guide', intent: 'informational',
      target_slug: 'hochzeit-planen', expected_entities: [], content_gaps: [],
    });

    const data = await discover({ ...config, base_url: 'https://acme.io' }, dir);
    expect(data.keywords.find(k => k.keyword === 'hochzeit planen').serp_features)
      .toEqual({ ...features, checked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(getSerp).toHaveBeenCalledWith('hochzeit planen', expect.objectContaining({ baseUrl: 'https://acme.io' }));
    expect(complete.mock.calls[0][0].prompt).toContain('SERP features present: ai_overview, videos');
  });

  it('adds the audience block to the scoring prompt only when seo/icp.md exists', async () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/icp.md'), 'ICP_MARKER Paare', 'utf8');
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'hochzeit planen', impressions: 50, clicks: 0, ctr: 0, position: 12 },
    ]);
    complete.mockResolvedValue({ score: 9, type: 'guide', intent: 'informational', target_slug: 'hochzeit-planen', expected_entities: [], content_gaps: [] });

    await discover(config, dir);
    expect(complete.mock.calls[0][0].prompt).toContain('## Zielgruppe (Sprachvorlage: Ton und Themen, keine Vorgaben zu Preisen oder Fakten, nie wörtlich zitieren, keine Namen)\nICP_MARKER Paare');
  });

  it('adds the audience block to the greenfield prompt only when seo/icp.md exists', async () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/icp.md'), 'ICP_MARKER Paare', 'utf8');
    querySearchAnalytics.mockResolvedValue([]);
    complete.mockResolvedValue([]);

    await discover({ ...config, greenfield: true }, dir);
    expect(complete.mock.calls[0][0].prompt).toContain('ICP_MARKER Paare');
  });

  it('narrows the GSC query to the project base_url so sibling subdomains do not fill the row limit', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    complete.mockResolvedValue([]);

    await discover({ ...config, base_url: 'https://acme.io' }, dir);

    expect(querySearchAnalytics).toHaveBeenCalledWith('sc-domain:acme.io', { pageFilter: 'https://acme.io' });
  });

  it('warns when the SerpAPI monthly quota is exhausted', async () => {
    checkQuota.mockReturnValueOnce({ used: 60, remaining: 0, limit: 60, month: '2026-06' });
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

  it('restricts the greenfield intent to the same enum as scoring', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    complete.mockResolvedValue([]);
    await discover({ ...config, greenfield: true }, dir);
    const schema = complete.mock.calls[0][0].schema;
    expect(schema.properties.keywords.items.properties.intent.enum)
      .toEqual(['informational', 'commercial', 'transactional', 'navigational', 'local']);
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

  it('ranks candidates by impressions before the 20-candidate budget cuts the list', async () => {
    // GSC returns rows clicks-descending. Put 20 low-impression, high-click
    // candidates ahead of one high-impression, clickless one so the old
    // clicks-order slice(0, 20) would drop it before it was ever scored.
    const filler = Array.from({ length: 20 }, (_, i) => ({
      keyword: `filler ${i}`, impressions: 6, clicks: 5, ctr: 0.8, position: 10,
    }));
    const buried = { keyword: 'sommerfest firma planen', impressions: 400, clicks: 0, ctr: 0, position: 20 };
    querySearchAnalytics.mockResolvedValue([...filler, buried]);
    let call = 0;
    complete.mockImplementation(() => Promise.resolve({
      score: 0, type: 'guide', intent: 'informational', target_slug: `slug-${call++}`,
      expected_entities: [], content_gaps: [], covered_by: null, reason: 'below cutoff',
    }));

    const data = await discover({ ...config, score_cutoff: 99 }, dir);

    expect(data.keywords.find(k => k.keyword === 'sommerfest firma planen')).toBeTruthy();
  });

  it('rethrows a spent budget from scoring instead of skipping the keyword', async () => {
    querySearchAnalytics.mockResolvedValue([
      { keyword: 'hochzeit planen', impressions: 50, clicks: 0, ctr: 0, position: 12 },
    ]);
    complete.mockRejectedValue(new BudgetExceededError('Anthropic monthly budget exhausted'));

    await expect(discover(config, dir)).rejects.toBeInstanceOf(BudgetExceededError);
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

  describe('shop mode', () => {
    const shopRow = { keyword: 'nachteule shirt', impressions: 40, clicks: 0, ctr: 0, position: 12 };
    const SHOP_PAGES = [{ keys: ['https://shop.test/shop/nachteule', 'nachteule shirt'], impressions: 40, position: 12 }];
    const scored = (slug) => ({
      score: 9, type: 'guide', intent: 'informational', target_slug: slug, expected_entities: [], content_gaps: [], covered_by: null, reason: '',
    });

    it('drops queries that only a /shop page answers when overlays are configured', async () => {
      querySearchAnalytics.mockResolvedValue([shopRow]);
      queryPagePerformance.mockResolvedValue(SHOP_PAGES);
      const data = await discover({ ...config, overlays: { products: 'content/seo/products' } }, dir);
      expect(data.keywords.find(k => k.keyword === 'nachteule shirt')).toBeUndefined();
      expect(complete).not.toHaveBeenCalled();
    });

    it('keeps a query that a non-shop page also answers', async () => {
      querySearchAnalytics.mockResolvedValue([shopRow]);
      queryPagePerformance.mockResolvedValue([
        ...SHOP_PAGES,
        { keys: ['https://shop.test/geschenke', 'nachteule shirt'], impressions: 5, position: 30 },
      ]);
      complete.mockResolvedValue(scored('nachteule-shirt'));
      const data = await discover({ ...config, overlays: { products: 'content/seo/products' } }, dir);
      expect(data.keywords.find(k => k.keyword === 'nachteule shirt')).toMatchObject({ status: 'proposed' });
    });

    it('keeps shop queries without overlays configured', async () => {
      querySearchAnalytics.mockResolvedValue([shopRow]);
      queryPagePerformance.mockResolvedValue(SHOP_PAGES);
      complete.mockResolvedValue(scored('nachteule-shirt'));
      const data = await discover(config, dir);
      expect(data.keywords.find(k => k.keyword === 'nachteule shirt')).toMatchObject({ status: 'proposed' });
    });

    it('skips a slug that is a reserved shop path', async () => {
      querySearchAnalytics.mockResolvedValue([{ ...shopRow, keyword: 'warenkorb hilfe' }]);
      complete.mockResolvedValue(scored('cart'));
      const data = await discover({ ...config, reserved_slugs: ['cart', 'admin'] }, dir);
      expect(data.keywords.find(k => k.target_slug === 'cart')).toBeUndefined();
    });

    it('gives greenfield the catalog and the contract rules', async () => {
      querySearchAnalytics.mockResolvedValue([]);
      complete.mockResolvedValue([]);
      await discover(
        { ...config, greenfield: true, page_contract: { products: { min: 3, max: 8 } } },
        dir,
        { catalog: makeCatalog() },
      );
      const prompt = complete.mock.calls[0][0].prompt;
      expect(prompt).toContain('- nachteule: nachteule');
      expect(prompt).toContain('3 to 8 product slugs');
      expect(prompt).toContain('saying and meaning of the designs');
    });

    it('leaves the greenfield prompt free of contract text without configuration', async () => {
      querySearchAnalytics.mockResolvedValue([]);
      complete.mockResolvedValue([]);
      await discover({ ...config, greenfield: true }, dir);
      expect(complete.mock.calls[0][0].prompt).not.toContain('Page contract');
    });
  });
});

describe('discover-run: Bing start mode', () => {
  const bingConfig = { ...config, base_url: 'https://acme.io', greenfield: true, bing: { enabled: true }, weekly_cap: 1 };
  const seed = (queries) => putSignal('bing', 'queries:https://acme.io/', queries, new Date(), { cwd: dir });
  const q = (query, impressions, position) => ({ query, impressions, clicks: 0, position });
  const scored = { score: 9, type: 'guide', intent: 'informational', target_slug: 'wie-plane-ich', expected_entities: [], content_gaps: [], covered_by: null };

  it('turns a Bing query into a candidate with source bing before greenfield runs', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    seed([q('wie plane ich eine hochzeit', 12, 10)]);
    complete.mockResolvedValue(scored);

    const data = await discover(bingConfig, dir);
    const kw = data.keywords.find(k => k.keyword === 'wie plane ich eine hochzeit');
    expect(kw).toMatchObject({ status: 'proposed', source: 'bing', bing: { impressions: 12, position: 10 } });
    expect(kw).not.toHaveProperty('gsc');
    expect(complete).toHaveBeenCalledTimes(1); // scoring only: the cap is full, greenfield stays out
  });

  it('applies the thresholds: position 8 to 25, at least max(5, min_impressions) impressions', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    seed([q('zu weit hinten', 50, 26), q('schon vorn', 50, 5), q('zu wenig', 4, 10)]);
    complete.mockResolvedValue([]);
    await discover(bingConfig, dir);
    expect(complete).toHaveBeenCalledTimes(1); // greenfield only, no scoring call
    expect(complete.mock.calls[0][0].schema.properties.keywords).toBeDefined();
  });

  it('fills the rest with greenfield when Bing candidates do not reach the cap', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    seed([q('wie plane ich eine hochzeit', 12, 10)]);
    complete.mockResolvedValueOnce({ ...scored, score: 3 }).mockResolvedValueOnce([
      { keyword: 'standesamt deko', target_slug: 'standesamt-deko', score: 8, type: 'guide', intent: 'informational' },
    ]);
    const data = await discover(bingConfig, dir);
    expect(data.keywords.find(k => k.keyword === 'standesamt deko')).toMatchObject({ source: 'greenfield' });
  });

  it('ignores Bing queries without greenfield and without bing.enabled', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    seed([q('wie plane ich eine hochzeit', 12, 10)]);
    complete.mockResolvedValue([]);
    await discover({ ...bingConfig, greenfield: false }, dir);
    await discover({ ...bingConfig, bing: { enabled: false } }, dir);
    expect(complete).toHaveBeenCalledTimes(1); // the second run is greenfield with nothing from Bing
    expect(complete.mock.calls[0][0].schema.properties.keywords).toBeDefined();
  });

  it('keeps the token duplicate guard: a word-order variant of a known keyword is skipped', async () => {
    querySearchAnalytics.mockResolvedValue([]);
    seed([q('planen hochzeit', 12, 10)]);
    await discover({ ...bingConfig, greenfield: false }, dir); // no-op, nothing stored
    const { upsertKeyword, loadKeywords, saveKeywords } = await import('../src/lib/keywords.js');
    const existing = loadKeywords(dir);
    upsertKeyword(existing, { keyword: 'hochzeit planen', status: 'proposed', score: 8, target_slug: 'hochzeit-planen' });
    saveKeywords(existing, dir);
    complete.mockResolvedValue([]);
    const data = await discover({ ...bingConfig, weekly_cap: 2 }, dir);
    expect(data.keywords.find(k => k.keyword === 'planen hochzeit')).toMatchObject({ status: 'skip' });
  });
});

