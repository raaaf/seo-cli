import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { highestYear, staleReason, pickStalePage } from '../src/lib/refresh.js';

const TODAY = '2026-11-16';
const page = ({ title = 'Preise', description = 'Beschreibung', headline = 'Headline', updated = '2026-10-01' } = {}) =>
  `---\nmeta_title: "${title}"\nmeta_description: "${description}"\nupdated: "${updated}"\nhero:\n  headline: "${headline}"\n---\nbody`;

describe('highestYear', () => {
  it('takes the highest year that states the state of things', () => {
    expect(highestYear('Preise Stand 2025, Update 2026', 2026)).toBe(2026);
  });

  it('ignores a year after seit, ab or bis', () => {
    expect(highestYear('Gilt seit 2025', 2026)).toBeNull();
    expect(highestYear('Ab dem 1. Januar 2027 neu', 2026)).toBeNull();
    expect(highestYear('Frist bis 2027, Stand 2025', 2026)).toBe(2025);
  });

  it('ignores a span whose end is not over and counts one that is', () => {
    expect(highestYear('Silvester 2026/27', 2026)).toBeNull();
    expect(highestYear('Silvester 2026/2027', 2026)).toBeNull();
    expect(highestYear('Silvester 2024/25', 2026)).toBe(2025);
  });
});

describe('staleReason', () => {
  it('is stale when the title still says last year', () => {
    expect(staleReason(page({ title: 'Preise Stand 2025' }), TODAY)).toMatch(/2025/);
  });

  it('is not stale for a year bound by seit, nor for a span that has not ended', () => {
    expect(staleReason(page({ description: 'Gilt seit 2025' }), TODAY)).toBeNull();
    expect(staleReason(page({ headline: 'Silvester 2026/27' }), TODAY)).toBeNull();
  });

  it('reads the headline of the hero block', () => {
    expect(staleReason(page({ headline: 'Der Guide 2024' }), TODAY)).toMatch(/2024/);
  });

  it('is stale when updated is older than 365 days, also as an unquoted date', () => {
    expect(staleReason(page({ updated: '2025-11-01' }), TODAY)).toMatch(/2025-11-01/);
    expect(staleReason('---\nmeta_title: "x"\nupdated: 2025-01-01\n---\nbody', TODAY)).toMatch(/2025-01-01/);
    expect(staleReason(page({ updated: '2025-12-01' }), TODAY)).toBeNull();
  });
});

describe('pickStalePage', () => {
  let dir;
  const config = { landing_path: 'content/de/', locale: 'de', locales: ['de'] };
  const write = (slug, md) => writeFileSync(join(dir, 'content/de', `${slug}.md`), md);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-refresh-'));
    mkdirSync(join(dir, 'content/de'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const today = new Date(`${TODAY}T12:00:00Z`);

  it('picks the stale page with the oldest update first and at most limit of them', () => {
    write('a', page({ title: 'A 2025', updated: '2025-12-01' }));
    write('b', page({ title: 'B 2024', updated: '2025-03-01' }));
    write('fresh', page());
    expect(pickStalePage({ config, cwd: dir, today, improvements: { entries: [] } })).toMatchObject({ slug: 'b' });
    expect(pickStalePage({ config, cwd: dir, today, improvements: { entries: [] }, limit: 2 }).map(p => p.slug)).toEqual(['b', 'a']);
  });

  it('leaves out pages in cooldown, excluded, skipped, or refreshed within 300 days', () => {
    for (const s of ['cool', 'excl', 'skipped', 'recent', 'failedonly']) write(s, page({ title: `${s} 2024` }));
    const days = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
    const improvements = { entries: [
      { slug: 'cool', date: days(10) },
      { slug: 'recent', date: days(120) },
      { slug: 'failedonly', date: days(120), failed: true },
    ] };
    expect(pickStalePage({ config: { ...config, exclude_slugs: ['excl'] }, cwd: dir, today, improvements, skip: ['skipped'], limit: 5 }).map(p => p.slug)).toEqual(['failedonly']);
  });
});
