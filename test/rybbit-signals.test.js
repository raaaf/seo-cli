import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/lib/safe-fetch.js', () => ({ assertPublicUrl: vi.fn(async () => {}) }));

const rybbit = await import('../src/lib/rybbit.js');
const { pageStats, fourWeekWindow, rybbitActive, getRybbitStats, readingStats, rybbitReport } = await import('../src/lib/signals/rybbit.js');
const { STATE_FILES } = await import('../src/lib/state.js');

const CONFIG = {
  base_url: 'https://a.de', landing_path: 'content/de/', locales: ['de'], locale: 'de', counterpart_locale: 'en', counterpart_url_prefix: '/en',
  rybbit: { enabled: true, url: 'https://t.example.org', site_id: 3, macro_goal: 'Signup', micro_goals: ['Preise'] },
};
const SLUGS = { de: ['alpha', 'beta'], en: ['alpha-en'] };
const e = (value, count, bounce = 50, time = 30) => ({ value, count, bounce_rate: bounce, time_on_page_seconds: time });
const goal = (name, n) => ({ goalId: 1, name, total_conversions: n, total_sessions: 100 });
const SITE_GOALS = [goal('Signup', 5), goal('Preise', 9)];
const byKey = (stats, key) => stats.pages.find(p => p.key === key);

describe('pageStats grouping', () => {
  it('folds path variants, query strings and trailing slashes into one page and weights the averages', () => {
    const raw = { entry: [e('/alpha', 30, 40, 20), e('/alpha/', 10, 80, 60), e('/alpha?utm=x', 10, 60, 40), e('/blog/post', 99), e('/', 50)] };
    const stats = pageStats(raw, CONFIG, SLUGS);
    expect(stats.pages).toHaveLength(1);
    expect(stats.pages[0]).toMatchObject({ key: 'de:alpha', entries: 50, bounce_rate: 52, time_on_page: 32 });
    expect(stats.totals).toMatchObject({ entries: 199, landing_entries: 50 });
  });

  it('keeps the counterpart locale apart and sorts by entries', () => {
    const stats = pageStats({ entry: [e('/beta', 5), e('/en/alpha-en', 9), e('/alpha', 2)] }, CONFIG, SLUGS);
    expect(stats.pages.map(p => p.key)).toEqual(['en:alpha-en', 'de:beta', 'de:alpha']);
  });

  it('counts AI entries as the larger of referrer and utm_source per path, never the sum', () => {
    const raw = { entry: [e('/alpha', 40)], ai_referrer: [e('/alpha', 3)], ai_utm: [e('/alpha', 5), e('/alpha/', 1)] };
    expect(pageStats(raw, CONFIG, SLUGS).pages[0].ai_entries).toBe(6);
  });

  it('lists AI sources by the larger count and null without any source answer', () => {
    const raw = { entry: [], ai_src_referrer: [e('chatgpt.com', 4)], ai_src_utm: [e('chatgpt.com', 2), e('claude.ai', 3)] };
    expect(pageStats(raw, CONFIG, SLUGS).ai_sources).toEqual([{ source: 'chatgpt.com', entries: 4 }, { source: 'claude.ai', entries: 3 }]);
    expect(pageStats({ entry: [] }, CONFIG, SLUGS).ai_sources).toBeNull();
  });
});

describe('pageStats goal rules', () => {
  const stats = (goals, siteGoals = SITE_GOALS) => byKey(pageStats({ entry: [e('/alpha', 40)], goals_all: siteGoals, goals: goals === undefined ? {} : { 'de:alpha': goals } }, CONFIG, SLUGS), 'de:alpha');

  it('reads conversions of the main goal and sums them with the side goals', () => {
    expect(stats([goal('Signup', 2), goal('Preise', 3)])).toMatchObject({ macro: 2, micro: 3 });
  });

  it('is 0 only when the goal exists, fires somewhere on the site and the page has none', () => {
    expect(stats([goal('Signup', 0), goal('Preise', 0)])).toMatchObject({ macro: 0, micro: 0 });
  });

  it('is null when no goal answer exists for the page', () => {
    expect(stats(undefined)).toMatchObject({ macro: null, micro: null });
  });

  it('is null for a goal that is missing on the page answer or on the site (renamed)', () => {
    expect(stats([goal('Preise', 1)])).toMatchObject({ macro: null, micro: 1 });
    expect(stats([goal('Signup', 1), goal('Preise', 1)], [goal('Preise', 9)])).toMatchObject({ macro: null });
  });

  it('is null for a goal without a single conversion site-wide, not 0', () => {
    expect(stats([goal('Signup', 0), goal('Preise', 0)], [goal('Signup', 0), goal('Preise', 9)])).toMatchObject({ macro: null, micro: 0 });
  });

  it('makes micro null as soon as one side goal is null, and 0 when the project names none', () => {
    const cfg = { ...CONFIG, rybbit: { ...CONFIG.rybbit, micro_goals: ['Preise', 'Wizard'] } };
    const raw = { entry: [e('/alpha', 40)], goals_all: SITE_GOALS, goals: { 'de:alpha': [goal('Preise', 2)] } };
    expect(byKey(pageStats(raw, cfg, SLUGS), 'de:alpha').micro).toBeNull();
    const none = { ...CONFIG, rybbit: { ...CONFIG.rybbit, micro_goals: [] } };
    expect(byKey(pageStats(raw, none, SLUGS), 'de:alpha').micro).toBe(0);
  });

  it('names goals that do not exist on the site', () => {
    const raw = { entry: [], goals_all: [goal('Preise', 1)] };
    expect(pageStats(raw, CONFIG, SLUGS).missing_goals).toEqual(['Signup']);
    expect(pageStats({ entry: [] }, CONFIG, SLUGS).missing_goals).toEqual([]);
  });
});

describe('readingStats', () => {
  const page = (key, entries, over = {}) => ({ key, entries, bounce_rate: 50, time_on_page: 30, ai_entries: 1, macro: 0, micro: 0, ...over });

  it('sums the pages of one change and keeps a null goal null', () => {
    const pages = [page('de:a', 10, { macro: 1 }), page('en:a', 30, { macro: null, bounce_rate: 90 }), page('de:other', 99)];
    expect(readingStats(pages, new Set(['de:a', 'en:a']))).toEqual({ entries: 40, bounce_rate: 80, time_on_page: 30, ai_entries: 2, macro: null, micro: 0 });
  });

  it('has no goal numbers for a page without entries', () => {
    expect(readingStats([], new Set(['de:a']))).toMatchObject({ entries: 0, macro: null, micro: null, bounce_rate: null });
  });
});

describe('fourWeekWindow', () => {
  it.each([
    ['2026-10-12', '2026-09-14', '2026-10-11'], // Monday
    ['2026-10-14', '2026-09-14', '2026-10-11'], // Wednesday
    ['2026-10-18', '2026-09-14', '2026-10-11'], // Sunday: the day itself is not complete
    ['2026-10-19', '2026-09-21', '2026-10-18'],
  ])('%s ends on the last full Sunday', (today, startDate, endDate) => {
    expect(fourWeekWindow(today)).toEqual({ startDate, endDate });
  });
});

describe('rybbitActive', () => {
  beforeEach(() => { process.env.RYBBIT_API_KEY = 'k'; });
  afterEach(() => { delete process.env.RYBBIT_API_KEY; });

  it('is on only for a complete config with a key', () => {
    expect(rybbitActive(CONFIG)).toBe(true);
    expect(rybbitActive({ ...CONFIG, rybbit: { ...CONFIG.rybbit, enabled: false } })).toBe(false);
  });

  it('warns once per message for a missing key and for an incomplete config', () => {
    const warnings = [];
    delete process.env.RYBBIT_API_KEY;
    expect(rybbitActive(CONFIG, warnings)).toBe(false);
    expect(rybbitActive(CONFIG, warnings)).toBe(false);
    expect(rybbitActive({ ...CONFIG, rybbit: { ...CONFIG.rybbit, site_id: null } }, warnings)).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('RYBBIT_API_KEY');
  });
});

it('keeps the signal file in the committed state files', () => {
  expect(STATE_FILES).toContain('seo/signals/rybbit.json');
});

describe('getRybbitStats', () => {
  const WINDOW = { startDate: '2026-10-05', endDate: '2026-10-11' };
  let dir, fetchMock, warnings, answers;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const calls = (method) => fetchMock.mock.calls.filter(([u]) => new URL(u).pathname.endsWith(`/${method}`));
  const run = (over = {}) => getRybbitStats({ config: CONFIG, cwd: dir, window: WINDOW, slugsByLocale: SLUGS, warnings, now: new Date('2026-10-12T00:00:00Z'), ...over });
  const stored = () => JSON.parse(readFileSync(join(dir, 'seo/signals/rybbit.json'), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-rybbit-'));
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    for (const slug of ['alpha', 'beta']) writeFileSync(join(dir, `content/de/${slug}.md`), '---\n---\n');
    warnings = [];
    answers = { entry: [e('/alpha', 40), e('/beta', 3)] };
    process.env.RYBBIT_API_KEY = 'k';
    rybbit.resetRybbitGuard();
    fetchMock = vi.fn(async (rawUrl) => {
      const url = new URL(rawUrl);
      const method = url.pathname.split('/').pop();
      if (method === 'goals') return json(200, { data: url.searchParams.has('filters') ? [goal('Signup', 0), goal('Preise', 0)] : SITE_GOALS });
      const parameter = url.searchParams.get('parameter');
      return json(200, { data: { data: parameter === 'entry_page' && !url.searchParams.has('filters') ? answers.entry : [] } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    delete process.env.RYBBIT_API_KEY;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('caches the raw answers under <site>:<endDate>:<kind> and reuses them within 7 days', async () => {
    const first = await run();
    expect(Object.keys(stored().entries)).toContain('3:2026-10-11:entry:2026-10-05');
    const before = fetchMock.mock.calls.length;
    const second = await run({ now: new Date('2026-10-14T00:00:00Z') });
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(second).toEqual(first);
    await run({ now: new Date('2026-10-20T00:00:00Z') });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('a dry run reads the live API and writes nothing', async () => {
    const stats = await run({ dryRun: true });
    expect(stats.pages[0].entries).toBe(40);
    expect(existsSync(join(dir, 'seo/signals/rybbit.json'))).toBe(false);
  });

  it('queries goals for every page with 30 entries or more beyond the top 10, and for no smaller page outside it', async () => {
    const big = Array.from({ length: 11 }, (_, i) => `p${i}`);
    answers.entry = [...big.map(slug => e(`/${slug}`, 40)), e('/small', 29)];
    await run({ slugsByLocale: { de: [...big, 'small'] } });
    const paths = calls('goals')
      .filter(([u]) => new URL(u).searchParams.has('filters'))
      .map(([u]) => JSON.parse(new URL(u).searchParams.get('filters'))[0].value[0]);
    expect(paths.sort()).toEqual(big.map(slug => `/${slug}`).sort());
  });

  it('queries goals for the top 10 even below 30 entries', async () => {
    const slugs = Array.from({ length: 12 }, (_, i) => `p${i}`);
    answers.entry = slugs.map((slug, i) => e(`/${slug}`, 5 + i));
    await run({ slugsByLocale: { de: slugs } });
    expect(calls('goals').filter(([u]) => new URL(u).searchParams.has('filters'))).toHaveLength(10);
  });

  it('goals for the given keys only', async () => {
    await run({ goalKeys: new Set(['de:beta']) });
    const filtered = calls('goals').filter(([u]) => new URL(u).searchParams.has('filters'));
    expect(filtered).toHaveLength(1);
  });

  it('returns the error kind when the entry pages fail, and writes nothing', async () => {
    fetchMock.mockImplementation(async () => json(401, {}));
    expect(await run()).toEqual({ error: 'key_rejected' });
    expect(existsSync(join(dir, 'seo/signals/rybbit.json'))).toBe(false);
    expect(warnings[0]).not.toContain('Bearer');
  });

  it('reads a failing goal call as null with a warning, the stats stay', async () => {
    fetchMock.mockImplementation(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/goals')) return json(500, {});
      return json(200, { data: { data: url.searchParams.has('filters') ? [] : answers.entry } });
    });
    const stats = await run();
    expect(stats.pages[0]).toMatchObject({ entries: 40, macro: null, micro: null });
    expect(warnings.some(w => w.includes('goals_all'))).toBe(true);
  });

  it('rybbitReport lists pages with 5+ entries only and turns an outage into an error section', async () => {
    const ok = await rybbitReport({ config: CONFIG, cwd: dir, warnings, today: '2026-10-14' });
    expect(ok.report.window).toEqual({ startDate: '2026-09-14', endDate: '2026-10-11' });
    expect(ok.report.pages.map(p => p.slug)).toEqual(['alpha']);
    expect(ok.pages).toHaveLength(2);

    fetchMock.mockImplementation(async () => json(503, {}));
    const down = await rybbitReport({ config: CONFIG, cwd: mkdtempSync(join(tmpdir(), 'seo-rybbit-')), warnings, today: '2026-10-14' });
    expect(down.report).toEqual({ error: 'unavailable' });
  });
});
