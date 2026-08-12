import { describe, it, expect } from 'vitest';
import { competingPages, isCannibalized, describeCompetitors, slugFromUrl } from '../src/lib/cannibalization.js';

const row = (page, query, impressions, position) => ({ keys: [page, query], impressions, position });

// The real shape of the 2026-08-12 measurement: three own pages on one query.
const ROWS = [
  row('https://events.rafaelalex.de/firmenfeier-planen', 'betriebsfeier organisieren', 15, 66.7),
  row('https://events.rafaelalex.de/firmenjubilaeum-organisieren', 'betriebsfeier organisieren', 11, 87.2),
  row('https://events.rafaelalex.de/betriebsausflug-planen', 'betriebsfeier organisieren', 5, 89.6),
  row('https://events.rafaelalex.de/firmenfeier-planen', 'sommerfest ideen', 40, 12.0),
];
const SLUGS = ['firmenfeier-planen', 'firmenjubilaeum-organisieren', 'betriebsausflug-planen'];

describe('slugFromUrl', () => {
  it('takes the last path segment', () => {
    expect(slugFromUrl('https://events.rafaelalex.de/firmenfeier-planen')).toBe('firmenfeier-planen');
    expect(slugFromUrl('https://x.de/de/firmenfeier-planen?utm=1')).toBe('firmenfeier-planen');
  });

  it('returns null for the home page and for unparseable input', () => {
    expect(slugFromUrl('https://x.de/')).toBe(null);
    expect(slugFromUrl('not a url')).toBe(null);
  });
});

describe('competingPages', () => {
  it('lists our own landing pages on that query, strongest first', () => {
    const pages = competingPages('betriebsfeier organisieren', ROWS, SLUGS);

    expect(pages.map(p => p.slug)).toEqual(['firmenfeier-planen', 'firmenjubilaeum-organisieren', 'betriebsausflug-planen']);
    expect(pages[0]).toMatchObject({ impressions: 15, position: 66.7 });
  });

  it('counts a word-order variant as the same query', () => {
    const rows = [row('https://x.de/a', 'organisieren betriebsfeier', 9, 40)];
    expect(competingPages('betriebsfeier organisieren', rows, ['a'])).toHaveLength(1);
  });

  it('ignores queries that only overlap partly', () => {
    expect(competingPages('sommerfest planen', ROWS, SLUGS)).toEqual([]);
  });

  it('ignores pages that are not landing pages, they share queries by design', () => {
    const rows = [
      row('https://zeit.rafaelalex.de/', 'zeiterfassung freelancer', 76, 31.6),
      row('https://zeit.rafaelalex.de/preise', 'zeiterfassung freelancer', 65, 66.6),
      row('https://zeit.rafaelalex.de/zeiterfassung-freelancer-software', 'zeiterfassung freelancer', 77, 43.3),
    ];
    const pages = competingPages('zeiterfassung freelancer', rows, ['zeiterfassung-freelancer-software']);

    expect(pages.map(p => p.slug)).toEqual(['zeiterfassung-freelancer-software']);
  });

  it('counts a page once even when it appears in several rows', () => {
    const rows = [
      row('https://x.de/a', 'betriebsfeier organisieren', 5, 80),
      row('https://x.de/a', 'organisieren betriebsfeier', 9, 40),
    ];
    const pages = competingPages('betriebsfeier organisieren', rows, ['a']);

    expect(pages).toHaveLength(1);
    expect(pages[0].impressions).toBe(9);
  });
});

describe('isCannibalized', () => {
  it('is true from two competing pages up', () => {
    expect(isCannibalized('betriebsfeier organisieren', ROWS, SLUGS)).toBe(true);
  });

  it('is false for a single ranking page, that is the page doing its job', () => {
    expect(isCannibalized('sommerfest ideen', ROWS, SLUGS)).toBe(false);
  });

  it('is false without page data, so a failed GSC call cannot block discovery', () => {
    expect(isCannibalized('betriebsfeier organisieren', [], SLUGS)).toBe(false);
  });
});

describe('describeCompetitors', () => {
  it('names slug and position for the log line', () => {
    expect(describeCompetitors(competingPages('betriebsfeier organisieren', ROWS, SLUGS)))
      .toBe('firmenfeier-planen (pos 66.7), firmenjubilaeum-organisieren (pos 87.2), betriebsausflug-planen (pos 89.6)');
  });
});
