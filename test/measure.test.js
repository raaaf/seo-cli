import { describe, it, expect } from 'vitest';
import {
  windowsFor, isDue, urlToSlug, aggregatePages, quantile, selectControls, verdictFor, isOverlap, isRevertCandidate,
} from '../src/lib/measure.js';

const CONFIG = { base_url: 'https://a.de', locales: ['de'], locale: 'de', counterpart_locale: 'en', counterpart_url_prefix: '/en' };
const SLUGS = { de: ['webdesign', 'preise-kalkulieren'], en: ['web-design'] };

describe('measure: windowsFor / isDue', () => {
  it('puts the baseline 28 days before the merge and skips the first 7 days after it', () => {
    expect(windowsFor('2026-09-01')).toEqual({
      baseline: { startDate: '2026-08-04', endDate: '2026-08-31' },
      d28: { startDate: '2026-09-09', endDate: '2026-10-06' },
      d56: { startDate: '2026-10-07', endDate: '2026-11-03' },
    });
  });

  it('is due when the window ended at least 3 days ago, not before', () => {
    const w = { startDate: '2026-09-09', endDate: '2026-10-06' };
    expect(isDue(w, '2026-10-09')).toBe(true);
    expect(isDue(w, '2026-10-08')).toBe(false);
  });
});

describe('measure: urlToSlug', () => {
  it('maps a default-locale URL, ignoring query, fragment and trailing slash', () => {
    expect(urlToSlug('https://a.de/webdesign/?utm=1#x', CONFIG, SLUGS)).toEqual({ slug: 'webdesign', locale: 'de' });
  });

  it('strips the counterpart prefix for the counterpart locale', () => {
    expect(urlToSlug('https://a.de/en/web-design', CONFIG, SLUGS)).toEqual({ slug: 'web-design', locale: 'en' });
  });

  it('maps a bare counterpart URL when the site uses no prefix', () => {
    expect(urlToSlug('https://a.de/web-design', { ...CONFIG, counterpart_url_prefix: '' }, SLUGS)).toEqual({ slug: 'web-design', locale: 'en' });
  });

  it('ignores pages that are no known landing page', () => {
    expect(urlToSlug('https://a.de/', CONFIG, SLUGS)).toBeNull();
    expect(urlToSlug('https://a.de/preise', CONFIG, SLUGS)).toBeNull();
    expect(urlToSlug('https://a.de/blog/webdesign', CONFIG, SLUGS)).toBeNull();
    expect(urlToSlug('https://other.de/webdesign', CONFIG, SLUGS)).toBeNull();
  });
});

describe('measure: aggregatePages / quantile', () => {
  it('weights the position by impressions and merges URL variants', () => {
    const pages = aggregatePages([
      { url: 'https://a.de/x', clicks: 1, impressions: 10, position: 2 },
      { url: 'https://a.de/x/', clicks: 3, impressions: 30, position: 8 },
    ]);
    expect(pages.get('https://a.de/x')).toEqual({ clicks: 4, impressions: 40, ctr: 0.1, position: 6.5 });
  });

  it('interpolates quantiles on a known series', () => {
    const series = [5, 1, 4, 2, 3];
    expect(quantile(series, 0.5)).toBe(3);
    expect(quantile(series, 0.1)).toBeCloseTo(1.4);
    expect(quantile(series, 0.9)).toBeCloseTo(4.6);
  });
});

describe('measure: selectControls', () => {
  const many = (n, impressions) => Array.from({ length: n }, (_, i) => ({ key: `u${i}`, impressions }));

  it('prefers pages between half and double the target level', () => {
    const picked = selectControls(200, [...many(12, 300), { key: 'big', impressions: 900 }]);
    expect(picked).toHaveLength(12);
    expect(picked.some(c => c.key === 'big')).toBe(false);
  });

  it('falls back to every page with at least 50 impressions when fewer than 12 are similar', () => {
    const picked = selectControls(200, [...many(11, 300), { key: 'big', impressions: 900 }, { key: 'tiny', impressions: 10 }]);
    expect(picked).toHaveLength(12);
    expect(picked.some(c => c.key === 'tiny')).toBe(false);
  });
});

describe('measure: verdictFor', () => {
  const page = (before, after) => ({ before: { clicks: before / 10, impressions: before }, after: { clicks: after / 10, impressions: after } });
  // Ratios from 1.0 to about 1.38, median about 1.19.
  const controls = Array.from({ length: 20 }, (_, i) => page(100, 100 + i * 2));
  const target = (after, before = 200) => page(before, after);

  it('is insufficient (volume) when the target has fewer than 100 impressions before', () => {
    expect(verdictFor({ target: target(500, 99), controls })).toMatchObject({ verdict: 'insufficient_data', reason: 'volume' });
  });

  it('stays measurable when the page collapses after the rewrite: 400 before, 10 after is negative', () => {
    expect(verdictFor({ target: target(10, 400), controls }).verdict).toBe('negative');
  });

  it('is insufficient (control) with fewer than 12 controls', () => {
    expect(verdictFor({ target: target(400), controls: controls.slice(0, 11) })).toMatchObject({ verdict: 'insufficient_data', reason: 'control' });
  });

  it('is insufficient (dispersion) when the controls scatter beyond a factor 4', () => {
    const wild = Array.from({ length: 20 }, (_, i) => page(100, i % 2 ? 1000 : 10));
    expect(verdictFor({ target: target(400), controls: wild })).toMatchObject({ verdict: 'insufficient_data', reason: 'dispersion' });
  });

  it('measures clicks from 20 baseline clicks, impressions below', () => {
    const t = { before: { clicks: 25, impressions: 200 }, after: { clicks: 25, impressions: 400 } };
    expect(verdictFor({ target: t, controls }).metric).toBe('clicks');
    t.before.clicks = 19;
    expect(verdictFor({ target: t, controls }).metric).toBe('impressions');
  });

  it('is positive only above the 90th percentile and at 1.3 times the median', () => {
    expect(verdictFor({ target: target(400), controls })).toMatchObject({ verdict: 'positive', controls: 20 });
    // above the 90th percentile (1.34) but only 1.18 times the median
    expect(verdictFor({ target: target(280), controls }).verdict).toBe('neutral');
  });

  it('is negative only below the 10th percentile and at 0.7 times the median', () => {
    expect(verdictFor({ target: target(100), controls }).verdict).toBe('negative');
    // below the 10th percentile (about 1.04) but 0.84 times the median
    expect(verdictFor({ target: target(200), controls }).verdict).toBe('neutral');
  });

  it('is neutral inside the control range and stores the ratio, quantiles and effect', () => {
    const v = verdictFor({ target: target(240), controls });
    expect(v.verdict).toBe('neutral');
    expect(v.metric).toBe('clicks');
    expect(v.r).toBeCloseTo(25 / 21);
    expect(v.effect).toBeCloseTo(v.r / v.median);
    expect(v.p10).toBeLessThan(v.median);
    expect(v.p90).toBeGreaterThan(v.median);
  });
});

describe('measure: isOverlap', () => {
  const entry = { id: 'e', urls: ['https://a.de/x', 'https://a.de/en/x'], merged_at: '2026-09-01' };
  const other = (merged_at, urls = ['https://a.de/en/x/']) => ({ id: 'o', urls, merged_at });

  it('detects another merge for the same page, counterpart included, in the baseline window', () => {
    expect(isOverlap(entry, [entry, other('2026-08-10')], { startDate: '2026-08-04', endDate: '2026-10-06' })).toBe(true);
  });

  it('detects another merge inside the measurement window', () => {
    expect(isOverlap(entry, [entry, other('2026-09-20')], { startDate: '2026-08-04', endDate: '2026-10-06' })).toBe(true);
  });

  it('ignores merges outside the window and merges of other pages', () => {
    const window = { startDate: '2026-08-04', endDate: '2026-10-06' };
    expect(isOverlap(entry, [entry, other('2026-10-07')], window)).toBe(false);
    expect(isOverlap(entry, [entry, other('2026-09-20', ['https://a.de/y'])], window)).toBe(false);
  });
});

describe('measure: isRevertCandidate', () => {
  const reading = (verdict, effect) => ({ verdict, effect });
  const entry = (d28, d56) => ({ readings: { d28, d56 } });

  it('needs two negative readings and an effect of at most 0.7 in the second', () => {
    expect(isRevertCandidate(entry(reading('negative', 0.5), reading('negative', 0.7)))).toBe(true);
    expect(isRevertCandidate(entry(reading('negative', 0.5), reading('negative', 0.71)))).toBe(false);
    expect(isRevertCandidate(entry(reading('neutral', 0.5), reading('negative', 0.5)))).toBe(false);
    expect(isRevertCandidate(entry(reading('negative', 0.5), null))).toBe(false);
  });
});
