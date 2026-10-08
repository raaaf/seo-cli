import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const {
  overlayFilePath, overlayKeyOfFile, renderOverlay, parseOverlay, validateOverlay,
  selectOverlayPage, isStartMode, pickStartTarget, prepareOverlay,
} = await import('../src/steps/overlay.js');
const { overlayKey, parseOverlayKey, loadImprovements, slugsInCooldown } = await import('../src/lib/improvements.js');
const { makeCatalog } = await import('./helpers/catalog.js');

const CONFIG = {
  base_url: 'https://shop.test', locale: 'de', locales: ['de'], gsc_property: 'sc-domain:shop.test',
  overlays: { products: 'content/seo/products', categories: 'content/seo/categories/' },
};
const CONTRACT = {
  lowercase: true,
  meta_title_suffix: ' . punkt und pause',
  facts_denylist: ['\\d+([,.]\\d+)?\\s*(€|eur|euro)'],
};
const catalog = makeCatalog();

const words = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? 'shirt' : 'nachteule')).join(' ');
const GOOD = {
  meta_title: 'nachteule shirt fuer lange naechte', // 35 chars
  meta_description: 'ein shirt fuer alle, die nachts erst richtig wach werden. weiche passform, ruhiges motiv, in den groessen s bis l erhaeltlich.',
  intro: words(60),
};
const GOOD_TITLE = 'nachteule shirt fuer lange naechte hier'; // 39 chars, keeps the short warning but valid
const errorsOf = (fields, extra = {}) => validateOverlay({ ...GOOD, ...fields }, { key: 'product:nachteule', ...extra }).errors;

describe('overlay: keys and paths', () => {
  it('builds and parses namespaced keys, and rejects plain slugs', () => {
    expect(overlayKey('product', 'nachteule')).toBe('product:nachteule');
    expect(parseOverlayKey('category:shirts')).toEqual({ type: 'category', id: 'shirts' });
    expect(parseOverlayKey('webdesign')).toBeNull();
  });

  it('maps a key to its configured file, tolerating a trailing slash in the directory', () => {
    expect(overlayFilePath(CONFIG, 'product:nachteule')).toBe('content/seo/products/nachteule.md');
    expect(overlayFilePath(CONFIG, 'category:shirts')).toBe('content/seo/categories/shirts.md');
    expect(overlayFilePath({ overlays: { products: 'p' } }, 'category:shirts')).toBeNull();
  });

  it('maps a file back to its key, and ignores files outside the overlay directories', () => {
    expect(overlayKeyOfFile(CONFIG, 'content/seo/products/nachteule.md')).toBe('product:nachteule');
    expect(overlayKeyOfFile(CONFIG, './content/seo/categories/shirts.md')).toBe('category:shirts');
    expect(overlayKeyOfFile(CONFIG, 'content/landing/de/webdesign.md')).toBeNull();
    expect(overlayKeyOfFile(CONFIG, 'content/seo/products/sub/x.md')).toBeNull();
  });

  it('renders three frontmatter fields and parses them back', () => {
    const md = renderOverlay({ ...GOOD, extra: 'dropped' });
    expect(md.startsWith('---\n')).toBe(true);
    expect(parseOverlay(md)).toEqual({ fields: GOOD, error: null });
  });

  it('reports a file without frontmatter', () => {
    expect(parseOverlay('just text').error).toBe('No YAML frontmatter found');
  });
});

describe('overlay: validateOverlay', () => {
  it('passes a clean product overlay', () => {
    const r = validateOverlay(GOOD, { key: 'product:nachteule', contract: CONTRACT, catalog });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('requires all three fields', () => {
    expect(errorsOf({ intro: '' })).toContain('Missing overlay field: intro');
  });

  it('shortens the title limit by the brand suffix', () => {
    const title = 'x'.repeat(50); // fine without the suffix, over 47 with it
    expect(errorsOf({ meta_title: title })).toEqual([]);
    expect(errorsOf({ meta_title: title }, { contract: CONTRACT })).toContain('meta_title too long (50 chars, max 47)');
  });

  it('caps the description at 170 characters', () => {
    expect(errorsOf({ meta_description: 'x'.repeat(171) })).toContain('meta_description too long (171 chars, max 170)');
  });

  it('keeps a product intro between 40 and 120 words', () => {
    expect(errorsOf({ intro: words(30) })).toContain('intro too short: 30 words (min 40)');
    expect(errorsOf({ intro: words(130) })).toContain('intro too long: 130 words (max 120)');
  });

  it('keeps a category intro at 60 words at most', () => {
    const errors = validateOverlay({ ...GOOD, intro: words(70) }, { key: 'category:shirts' }).errors;
    expect(errors).toContain('intro too long: 70 words (max 60)');
  });

  it('wants a single-paragraph intro', () => {
    expect(errorsOf({ intro: `${words(30)}\n\n${words(30)}` })).toContain('intro must be a single paragraph');
  });

  it('rejects an em-dash and emoji', () => {
    expect(errorsOf({ meta_title: 'nachteule — shirt' }).some(e => e.startsWith('Em-dash'))).toBe(true);
  });

  it('enforces lowercase only with the contract flag', () => {
    expect(errorsOf({ meta_title: 'Nachteule shirt' })).toEqual([]);
    expect(errorsOf({ meta_title: 'Nachteule shirt' }, { contract: CONTRACT }).some(e => e.includes('meta_title'))).toBe(true);
  });

  it('rejects a price the catalog does not state', () => {
    const errors = errorsOf({ meta_description: `${GOOD.meta_description} nur 19,99 euro` }, { contract: CONTRACT, catalog });
    expect(errors.some(e => e.startsWith('Claim not backed by the catalog'))).toBe(true);
  });

  it('rejects an overlay whose target left the catalog', () => {
    expect(validateOverlay(GOOD, { key: 'product:weg', catalog }).errors).toContain('Overlay target not in the catalog: product:weg');
    expect(validateOverlay({ ...GOOD, intro: words(50) }, { key: 'category:weg', catalog }).errors).toContain('Overlay target not in the catalog: category:weg');
  });
});

describe('overlay: selection', () => {
  const row = (url, query, impressions, position = 12, clicks = 0) => ({ url, query, impressions, position, clicks });
  const rows = [
    row('https://shop.test/shop/nachteule', 'nachteule shirt', 60),
    row('https://shop.test/shop/sonntag', 'sonntag shirt', 200),
    row('https://shop.test/shop?category=shirts', 'shirts kaufen', 90),
    row('https://shop.test/webdesign', 'webdesign', 900),
    row('https://shop.test/shop/regenbogen', 'regenbogen', 5),
  ];

  it('picks the shop page with the strongest case and ignores landing pages', () => {
    const page = selectOverlayPage({ rows, config: CONFIG });
    expect(page.slug).toBe('product:sonntag');
    expect(page.queries[0].query).toBe('sonntag shirt');
  });

  it('maps a category URL to a category key', () => {
    const page = selectOverlayPage({ rows: [rows[2]], config: CONFIG });
    expect(page.slug).toBe('category:shirts');
  });

  it('skips keys in cooldown', () => {
    const page = selectOverlayPage({ rows, config: CONFIG, cooldown: new Set(['product:sonntag']) });
    expect(page.slug).toBe('category:shirts');
  });

  it('skips targets the catalog does not know', () => {
    const page = selectOverlayPage({ rows: [row('https://shop.test/shop/weg', 'weg shirt', 500), rows[0]], config: CONFIG, catalog });
    expect(page.slug).toBe('product:nachteule');
  });

  it('returns null when nothing is above the impression floor', () => {
    expect(selectOverlayPage({ rows: [rows[4]], config: CONFIG })).toBeNull();
  });

  it('knows start mode: no row with /shop/ in the path', () => {
    expect(isStartMode([rows[3]])).toBe(true);
    expect(isStartMode([])).toBe(true);
    expect(isStartMode(rows)).toBe(false);
  });
});

describe('overlay: start target and prepareOverlay', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-overlay-'));
    complete.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedOverlay = (slug) => {
    mkdirSync(join(dir, 'content/seo/products'), { recursive: true });
    writeFileSync(join(dir, 'content/seo/products', `${slug}.md`), '---\nmeta_title: x\n---\n');
  };
  const start = (cooldown = new Set()) => pickStartTarget({ config: CONFIG, catalog, cwd: dir, cooldown });

  it('starts with the first product in catalog order', () => {
    expect(start().slug).toBe('product:tanz-mit-mir');
  });

  it('skips products that have an overlay or are in cooldown', () => {
    seedOverlay('tanz-mit-mir');
    expect(start(new Set(['product:nachteule'])).slug).toBe('product:kaffee-first');
  });

  it('returns null when every product has an overlay', () => {
    for (const p of catalog.products) seedOverlay(p.slug);
    expect(start()).toBeNull();
  });

  it('adds the audience block to the overlay prompt only when seo/icp.md exists', async () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/icp.md'), 'ICP_MARKER Tänzer');
    complete.mockResolvedValue({ ...GOOD, meta_title: GOOD_TITLE });
    await prepareOverlay({ config: { ...CONFIG, page_contract: CONTRACT }, cwd: dir, rows: [], catalog });
    expect(complete.mock.calls[0][0].prompt).toContain('## Zielgruppe (Sprachvorlage: Ton und Themen, keine Vorgaben zu Preisen oder Fakten, nie wörtlich zitieren, keine Namen)\nICP_MARKER Tänzer');
  });

  it('writes one overlay in start mode in the shape publishImprove takes', async () => {
    complete.mockResolvedValue({ ...GOOD, meta_title: GOOD_TITLE });
    const prepared = await prepareOverlay({ config: { ...CONFIG, page_contract: CONTRACT }, cwd: dir, rows: [], catalog });
    expect(prepared.slug).toBe('product:tanz-mit-mir');
    expect(prepared.branch).toBe('seo/improve/product-tanz-mit-mir');
    expect(prepared.files).toEqual([{ path: 'content/seo/products/tanz-mit-mir.md', content: renderOverlay({ ...GOOD, meta_title: GOOD_TITLE }) }]);
    expect(prepared.record).toEqual({ slug: 'product:tanz-mit-mir', queries: [] });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ json: true, model: 'claude-sonnet-5-5', batch: true }));
  });

  it('retries once with the validator errors and keeps the second text', async () => {
    complete.mockResolvedValueOnce({ ...GOOD, intro: words(5) }).mockResolvedValueOnce(GOOD);
    const prepared = await prepareOverlay({ config: CONFIG, cwd: dir, rows: [], catalog });
    expect(prepared.files[0].content).toBe(renderOverlay(GOOD));
    expect(complete.mock.calls[1][0].prompt).toContain('intro too short: 5 words');
  });

  it('discards the overlay when both attempts fail', async () => {
    complete.mockResolvedValue({ ...GOOD, intro: words(5) });
    expect(await prepareOverlay({ config: CONFIG, cwd: dir, rows: [], catalog })).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('puts a target that fails twice into the cooldown with a failed note', async () => {
    complete.mockResolvedValue({ ...GOOD, intro: words(5) });
    await prepareOverlay({ config: CONFIG, cwd: dir, rows: [], catalog });
    const { entries } = loadImprovements(dir);
    expect(entries).toEqual([expect.objectContaining({ slug: 'product:tanz-mit-mir', failed: true })]);
    expect(slugsInCooldown({ entries }).has('product:tanz-mit-mir')).toBe(true);
  });

  it('rewrites the shop page with the strongest case once GSC has shop rows', async () => {
    complete.mockResolvedValue(GOOD);
    const rows = [{ url: 'https://shop.test/shop/nachteule', query: 'nachteule shirt', impressions: 80, position: 11, clicks: 0 }];
    const prepared = await prepareOverlay({ config: CONFIG, cwd: dir, rows, catalog });
    expect(prepared.slug).toBe('product:nachteule');
    expect(prepared.record.queries).toEqual(['nachteule shirt']);
    expect(complete.mock.calls[0][0].prompt).toContain('nachteule shirt');
  });

  it('does nothing without the overlays key', async () => {
    expect(await prepareOverlay({ config: { ...CONFIG, overlays: null }, cwd: dir, rows: [], catalog })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('skips when the catalog is unreachable', async () => {
    const config = { ...CONFIG, catalog_url: 'http://localhost/catalog.json' };
    expect(await prepareOverlay({ config, cwd: dir, rows: [] })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('prints and returns nothing on a dry run', async () => {
    complete.mockResolvedValue(GOOD);
    expect(await prepareOverlay({ config: CONFIG, cwd: dir, rows: [], catalog, dryRun: true })).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
