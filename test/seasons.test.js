import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { activeSeasons, pickSeasonPage } = await import('../src/lib/seasons.js');

const day = (iso) => new Date(`${iso}T12:00:00Z`);
const names = (seasons, today) => activeSeasons(seasons, day(today)).map(s => s.name);

describe('activeSeasons', () => {
  const xmas = { name: 'xmas', peak: '12-24', lead_weeks: 10 };

  it('is active inside the window, on both edges', () => {
    expect(names([xmas], '2026-12-01')).toEqual(['xmas']);
    expect(names([xmas], '2026-10-15')).toEqual(['xmas']); // exactly 70 days before
    expect(names([xmas], '2026-12-24')).toEqual(['xmas']); // peak day
  });

  it('is inactive before the window', () => {
    expect(names([xmas], '2026-10-14')).toEqual([]);
  });

  it('is inactive after the peak (the next peak is a year away)', () => {
    expect(names([xmas], '2026-12-25')).toEqual([]);
  });

  it('wraps over the year change', () => {
    const newYear = { name: 'ny', peak: '01-15', lead_weeks: 10 };
    expect(names([newYear], '2026-12-10')).toEqual(['ny']);
    expect(activeSeasons([newYear], day('2026-12-10'))[0].peak).toBe('2027-01-15');
    expect(names([newYear], '2026-10-01')).toEqual([]);
  });

  it('keeps an evergreen season active all year, after the dated ones, without pages', () => {
    const evergreen = { name: 'gifts', evergreen: true, keywords: ['geschenk'], pages: ['some-page'] };
    for (const today of ['2026-01-01', '2026-06-30', '2026-12-31']) expect(names([evergreen], today)).toEqual(['gifts']);
    const active = activeSeasons([evergreen, xmas], day('2026-12-01'));
    expect(active.map(s => s.name)).toEqual(['xmas', 'gifts']);
    expect(active[1]).toMatchObject({ peak: null, evergreen: true, keywords: ['geschenk'], pages: [] });
  });

  it('defaults lead_weeks to 10', () => {
    const season = activeSeasons([{ name: 'a', peak: '12-24' }], day('2026-10-15'));
    expect(season[0].lead_weeks).toBe(10);
    expect(names([{ name: 'a', peak: '12-24' }], '2026-10-14')).toEqual([]);
  });

  it('skips malformed entries with a warning and keeps the valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = names([
        { peak: '12-24' },
        { name: 'bad-format', peak: '1224' },
        { name: 'bad-date', peak: '02-30' },
        { name: 'zero-lead', peak: '12-24', lead_weeks: 0 },
        { name: 'neg-lead', peak: '12-24', lead_weeks: -3 },
        null,
        xmas,
      ], '2026-12-01');
      expect(result).toEqual(['xmas']);
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });

  it('sorts the nearest peak first and returns keywords and pages', () => {
    const result = activeSeasons([
      xmas,
      { name: 'nikolaus', peak: '12-06', keywords: ['nikolaus basteln'], pages: ['nikolaus'] },
    ], day('2026-12-01'));
    expect(result.map(s => s.name)).toEqual(['nikolaus', 'xmas']);
    expect(result[0]).toMatchObject({ peak: '2026-12-06', keywords: ['nikolaus basteln'], pages: ['nikolaus'] });
  });

  it('trims and de-duplicates keywords and pages', () => {
    const [s] = activeSeasons([{ name: 'a', peak: '12-24', keywords: [' x ', 'x', 'y', 3], pages: ['p', 'p '] }], day('2026-12-01'));
    expect(s.keywords).toEqual(['x', 'y']);
    expect(s.pages).toEqual(['p']);
  });

  it('treats a missing list as no seasons', () => {
    expect(activeSeasons(undefined, day('2026-12-01'))).toEqual([]);
  });
});

describe('pickSeasonPage', () => {
  const today = day('2026-12-01');
  const daysAgo = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
  let dir;
  const config = (extra = {}) => ({
    locale: 'de', landing_path: 'content/landing/de/',
    seasons: [{ name: 'xmas', peak: '12-24', pages: ['weihnachten', 'adventsfeier'] }],
    ...extra,
  });
  const page = (slug) => {
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    writeFileSync(join(dir, 'content/landing/de', `${slug}.md`), `---\nslug: ${slug}\n---\nbody`);
  };
  const history = (...entries) => ({ entries: entries.map(([slug, ago]) => ({ slug, date: daysAgo(ago) })) });
  const pick = (cfg, improvements = { entries: [] }) => pickSeasonPage({ config: cfg, cwd: dir, today, improvements });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-season-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('picks the first listed page that exists', () => {
    page('adventsfeier');
    expect(pick(config())).toEqual({ slug: 'adventsfeier', season: 'xmas', peak: '2026-12-24' });
  });

  it('returns null without seasons, without an active season or without an existing page', () => {
    page('weihnachten');
    expect(pick(config({ seasons: [] }))).toBeNull();
    expect(pick(config({ seasons: [{ name: 'x', peak: '06-01', pages: ['weihnachten'] }] }))).toBeNull();
    expect(pick(config({ seasons: [{ name: 'x', peak: '12-24', pages: ['gibt-es-nicht'] }] }))).toBeNull();
  });

  it('skips a page inside the 56-day cooldown', () => {
    page('weihnachten'); page('adventsfeier');
    expect(pick(config(), history(['weihnachten', 55])).slug).toBe('adventsfeier');
  });

  it('skips a page rewritten within 300 days, also after the cooldown ended', () => {
    page('weihnachten'); page('adventsfeier');
    expect(pick(config(), history(['weihnachten', 299])).slug).toBe('adventsfeier');
    expect(pick(config(), history(['weihnachten', 301])).slug).toBe('weihnachten');
  });

  it('holds a failed attempt off for the 56-day cooldown only', () => {
    page('weihnachten');
    const failed = (ago) => ({ entries: [{ slug: 'weihnachten', date: daysAgo(ago), failed: true }] });
    expect(pick(config(), failed(10))).toBeNull();
    expect(pick(config(), failed(60)).slug).toBe('weihnachten');
  });

  it('returns null when every listed page was rewritten recently', () => {
    page('weihnachten');
    expect(pick(config(), history(['weihnachten', 100]))).toBeNull();
  });

  it('never touches an excluded slug', () => {
    page('weihnachten');
    expect(pick(config({ exclude_slugs: ['weihnachten'] }))).toBeNull();
  });

  it('prefers the season with the nearest peak', () => {
    page('weihnachten'); page('nikolaus');
    const seasons = [
      { name: 'xmas', peak: '12-24', pages: ['weihnachten'] },
      { name: 'nikolaus', peak: '12-06', pages: ['nikolaus'] },
    ];
    expect(pick(config({ seasons })).season).toBe('nikolaus');
  });
});
