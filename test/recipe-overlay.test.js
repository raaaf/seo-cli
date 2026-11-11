import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { renderOverlay, parseOverlay, validateOverlay, overlayFilePath, overlayKeyOfFile, prepareOverlay, pickRecipeTarget } = await import('../src/steps/overlay.js');
const { assertRecipeCatalogShape, loadRecipeCatalog, resetRecipeCatalogCache, numbersNotInRecipe } = await import('../src/lib/recipe-catalog.js');
const { urlToSlug, overlayUrl } = await import('../src/lib/measure.js');
const { pickAssessedPage, annotateFollowups } = await import('../src/lib/assessed-rewrite.js');

const BASE = 'https://topf.test';
const CONFIG = {
  project: 'topf', base_url: BASE, locale: 'de', locales: ['de'], site_name: 'Topf-Secret',
  overlays: { recipes: 'backend/content/seo/recipes' },
  recipe_catalog_url: `${BASE}/seo/recipes.json`,
  page_contract: { meta_title_suffix: ' | Topf-Secret' },
};

const SHAKSHUKA = {
  slug: 'shakshuka', url: `${BASE}/rezept/shakshuka`, title: 'Shakshuka',
  summary: 'Eier in würziger Tomatensauce.', servings: 2, totalTimeMinutes: 30,
  ingredients: ['400 g Tomaten', '4 Eier', '1 Zwiebel', '1 TL Kreuzkümmel'],
  steps: ['Zwiebel 5 Minuten anschwitzen.', 'Tomaten zugeben und 10 Minuten köcheln.', 'Eier hineinsetzen und zugedeckt garen.'],
  tags: ['Hauptgericht'], dietTags: ['vegetarisch'],
};
const DAL = { ...SHAKSHUKA, slug: 'dal', url: `${BASE}/rezept/dal`, title: 'Rotes Linsen-Dal' };
const RECIPES = { version: 1, recipes: [SHAKSHUKA, DAL] };

const words = (n, w = 'Tomatensauce') => Array.from({ length: n }, () => w).join(' ');
const GOOD = {
  meta_title: 'Shakshuka: Eier in Tomatensauce aus der Pfanne',
  meta_description: 'Shakshuka für 2 Personen: Eier gar ziehen in einer Sauce aus Tomaten, Zwiebel und Kreuzkümmel. In 30 Minuten fertig, vegetarisch und aus einer Pfanne.',
  intro: `Shakshuka ist ein Pfannengericht, bei dem 4 Eier in einer würzigen Sauce garen. ${words(30)}`,
  notes: `Die Zwiebel braucht 5 Minuten, damit sie weich wird. ${words(50)}\n\nDie Eier garen zugedeckt, so stockt das Eiweiß. ${words(40)}`,
};
const errorsOf = (fields = {}, recipes = RECIPES) => validateOverlay({ ...GOOD, ...fields }, { key: 'recipe:shakshuka', contract: CONFIG.page_contract, recipes }).errors;

describe('recipe catalog', () => {
  it('accepts the documented shape and rejects broken entries', () => {
    expect(assertRecipeCatalogShape(RECIPES)).toBe(RECIPES);
    expect(() => assertRecipeCatalogShape({ version: 2, recipes: [] })).toThrow(/version/);
    expect(() => assertRecipeCatalogShape({ version: 1, recipes: [{ ...SHAKSHUKA, steps: 'x' }] })).toThrow(/steps/);
    expect(() => assertRecipeCatalogShape({ version: 1, recipes: [{ ...SHAKSHUKA, servings: 0 }] })).toThrow(/servings/);
  });

  it('loads once per process and is null without the key', async () => {
    resetRecipeCatalogCache();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => RECIPES });
    expect(await loadRecipeCatalog({}, { fetchImpl })).toBeNull();
    expect(await loadRecipeCatalog(CONFIG, { fetchImpl })).toBe(RECIPES);
    await loadRecipeCatalog(CONFIG, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resetRecipeCatalogCache();
    await expect(loadRecipeCatalog(CONFIG, { fetchImpl: async () => ({ ok: false, status: 503 }) })).rejects.toThrow(/HTTP 503/);
  });

  it('lists numbers the recipe does not state, step numbers included as stated', () => {
    expect(numbersNotInRecipe('In 30 Minuten für 2, nach 5 Minuten, Schritt 3, 400 g', SHAKSHUKA)).toEqual([]);
    expect(numbersNotInRecipe('Bei 180 Grad 25 Minuten, 320 kcal', SHAKSHUKA)).toEqual(['180', '25', '320']);
  });
});

describe('recipe overlay: keys, URLs, files', () => {
  it('maps /rezept/<slug> to recipe:<slug> and back', () => {
    expect(urlToSlug(`${BASE}/rezept/shakshuka/`, CONFIG, {})).toEqual({ slug: 'recipe:shakshuka', locale: 'de', overlay: true });
    expect(urlToSlug(`${BASE}/rezept/a/b`, CONFIG, {})).toBeNull();
    expect(urlToSlug(`${BASE}/impressum`, CONFIG, {})).toBeNull();
    expect(overlayUrl(CONFIG, 'recipe:shakshuka')).toBe(`${BASE}/rezept/shakshuka`);
    expect(overlayUrl({ ...CONFIG, overlays: { recipes: 'x', recipe_path: 'recipes/' } }, 'recipe:a')).toBe(`${BASE}/recipes/a`);
  });

  it('finds the file of a key and the key of a file', () => {
    expect(overlayFilePath(CONFIG, 'recipe:shakshuka')).toBe('backend/content/seo/recipes/shakshuka.md');
    expect(overlayKeyOfFile(CONFIG, 'backend/content/seo/recipes/shakshuka.md')).toBe('recipe:shakshuka');
  });

  it('renders JSON-quoted frontmatter plus the notes as body, and parses it back', () => {
    const md = renderOverlay({ ...GOOD, meta_title: 'Shakshuka: "scharf" & schnell' }, 'recipe');
    expect(md).toContain('meta_title: "Shakshuka: \\"scharf\\" & schnell"\n');
    expect(md.endsWith(`${GOOD.notes}\n`)).toBe(true);
    const { fields, error } = parseOverlay(md);
    expect(error).toBeNull();
    expect(fields).toEqual({ ...GOOD, meta_title: 'Shakshuka: "scharf" & schnell' });
  });
});

describe('recipe overlay: validateOverlay', () => {
  it('passes a text that keeps to the recipe', () => {
    expect(errorsOf()).toEqual([]);
  });

  it('rejects a number the recipe does not state', () => {
    expect(errorsOf({ intro: `${GOOD.intro} Bei 180 Grad.` }).join()).toMatch(/Number not stated by the recipe: 180/);
  });

  it('rejects markup, links, statistics and the wrong paragraph count', () => {
    expect(errorsOf({ notes: `## Tipps\n\n${GOOD.notes}` }).join()).toMatch(/Markup/);
    expect(errorsOf({ intro: `${GOOD.intro} Mehr auf https://x.test` }).join()).toMatch(/Link/);
    expect(errorsOf({ intro: `${GOOD.intro} Laut einer Studie mögen es alle.` }).join()).toMatch(/Unsourced statistic/);
    expect(errorsOf({ notes: words(120) }).join()).toMatch(/2 to 4 paragraphs, has 1/);
    expect(errorsOf({ notes: 'Kurz.\n\nZu kurz.' }).join()).toMatch(/notes too short/);
  });

  it('respects the title suffix and needs the recipe in the catalog', () => {
    expect(errorsOf({ meta_title: 'x'.repeat(60) }).join()).toMatch(/meta_title too long \(60 chars, max 51\)/);
    expect(errorsOf({}, { version: 1, recipes: [DAL] }).join()).toMatch(/not in the recipe catalog/);
  });
});

describe('recipe overlay: prepareOverlay', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-recipe-'));
    complete.mockReset();
    resetRecipeCatalogCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
  // The catalog goes into the module cache through an injected fetch, so prepareOverlay never hits the network.
  const primeCatalog = () => loadRecipeCatalog(CONFIG, { fetchImpl: async () => ({ ok: true, json: async () => RECIPES }) });

  it('takes the first recipe without an overlay when Search Console has nothing', async () => {
    mkdirSync(join(dir, 'backend/content/seo/recipes'), { recursive: true });
    writeFileSync(join(dir, 'backend/content/seo/recipes/shakshuka.md'), renderOverlay(GOOD, 'recipe'));
    expect(pickRecipeTarget({ config: CONFIG, recipes: RECIPES, cwd: dir, cooldown: new Set() }).slug).toBe('recipe:dal');
    expect(pickRecipeTarget({ config: CONFIG, recipes: RECIPES, cwd: dir, cooldown: new Set(['recipe:dal']) })).toBeNull();
  });

  it('writes the assessed recipe with the diagnosis in the prompt, in the shape publishImprove takes', async () => {
    await primeCatalog();
    complete.mockResolvedValue(GOOD);
    const prepared = await prepareOverlay({
      config: CONFIG, cwd: dir,
      target: { slug: 'recipe:shakshuka', queries: [], reason: 'Index-Bewertung', diagnosis: 'DIAG_MARKER zu dünn', assessed: 'deindexed:x' },
    });
    expect(prepared).toMatchObject({ slug: 'recipe:shakshuka', assessed: 'deindexed:x', branch: 'seo/improve/recipe-shakshuka' });
    expect(prepared.files).toEqual([{ path: 'backend/content/seo/recipes/shakshuka.md', content: renderOverlay(GOOD, 'recipe') }]);
    const { prompt, schema } = complete.mock.calls[0][0];
    expect(prompt).toContain('DIAG_MARKER zu dünn');
    expect(prompt).toContain('2. Tomaten zugeben und 10 Minuten köcheln.');
    expect(prompt).toContain('- Rotes Linsen-Dal');
    expect(schema.required).toEqual(['meta_title', 'meta_description', 'intro', 'notes']);
  });

  it('retries with the validator errors and gives up after two failures', async () => {
    await primeCatalog();
    complete.mockResolvedValue({ ...GOOD, intro: `${GOOD.intro} 320 kcal.` });
    const target = { slug: 'recipe:shakshuka', queries: [], reason: 'r' };
    expect(await prepareOverlay({ config: CONFIG, cwd: dir, target })).toBeNull();
    expect(complete.mock.calls[1][0].prompt).toContain('Number not stated by the recipe: 320');
  });

  it('skips when the recipe catalog is unreachable', async () => {
    const fail = { ...CONFIG, recipe_catalog_url: 'http://127.0.0.1/nope.json' };
    expect(await prepareOverlay({ config: fail, cwd: dir, target: { slug: 'recipe:shakshuka', queries: [], reason: 'r' } })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('recipe overlay: assessed alerts', () => {
  const alert = (url, extra = {}) => ({
    id: `deindexed:${url}`, kind: 'deindexed',
    diagnosis: { cause: 'clean', urls: [{ url, findings: [] }] },
    assessment: { assessed_at: '2026-11-05', likely_causes: ['dünn'], actions: [{ action: 'mehr Inhalt' }] },
    ...extra,
  });
  const today = new Date('2026-11-12T12:00:00Z');

  it('maps a recipe URL to its overlay key, without landing pages', () => {
    const open = [alert(`${BASE}/impressum`), alert(`${BASE}/rezept/shakshuka`)];
    expect(pickAssessedPage({ config: CONFIG, cwd: '/nonexistent', today, improvements: { entries: [] }, alerts: { open } }))
      .toMatchObject({ slug: 'recipe:shakshuka', alert_id: `deindexed:${BASE}/rezept/shakshuka` });
  });

  it('leaves recipe pages alone without recipe overlays, and respects the cooldown', () => {
    const open = [alert(`${BASE}/rezept/shakshuka`)];
    expect(pickAssessedPage({ config: { ...CONFIG, overlays: null }, cwd: '/nonexistent', today, improvements: { entries: [] }, alerts: { open } })).toBeNull();
    const improvements = { entries: [{ slug: 'recipe:shakshuka', date: '2026-11-01' }] };
    expect(pickAssessedPage({ config: CONFIG, cwd: '/nonexistent', today, improvements, alerts: { open } })).toBeNull();
  });

  it('annotates a recipe assessment as scheduled or rewritten', () => {
    const url = `${BASE}/rezept/shakshuka`;
    const [s] = annotateFollowups({ assessments: [{ alert_id: `deindexed:${url}` }], config: CONFIG, cwd: '/nonexistent', prs: [], today: '2026-11-12', improvements: { entries: [] } });
    expect(s.followup).toEqual({ status: 'scheduled', slug: 'recipe:shakshuka', not_before: '2026-11-12' });
  });
});
