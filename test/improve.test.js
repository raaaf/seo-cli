import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scorePage, selectPage } from '../src/steps/improve.js';
import { loadImprovements, recordImprovement, slugsInCooldown } from '../src/lib/improvements.js';

const config = {
  base_url: 'https://acme.io',
  landing_path: 'content/landing/de/',
  locale: 'de',
};

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'seo-improve-'));
  mkdirSync(join(cwd, 'content/landing/de'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function seedPages(...slugs) {
  for (const slug of slugs) {
    writeFileSync(join(cwd, 'content/landing/de', `${slug}.md`), `---\nslug: ${slug}\n---\n\nText.`, 'utf8');
  }
}

describe('scorePage', () => {
  it('ignores pages below the impression floor', () => {
    expect(scorePage({ impressions: 19, clicks: 0, bestPosition: 3 })).toBeNull();
  });

  it('weights a clickless top-five page highest', () => {
    const snippet = scorePage({ impressions: 100, clicks: 0, bestPosition: 2 });
    const nearPage1 = scorePage({ impressions: 100, clicks: 4, bestPosition: 11 });
    expect(snippet.kind).toBe('snippet');
    expect(snippet.score).toBeGreaterThan(nearPage1.score);
  });

  it('treats a top-five page with clicks as an ordinary near-page-one case', () => {
    expect(scorePage({ impressions: 100, clicks: 3, bestPosition: 3 }).kind).toBe('near_page1');
  });

  it('scores pages beyond position 20 lowest', () => {
    expect(scorePage({ impressions: 100, clicks: 0, bestPosition: 40 }).kind).toBe('far');
  });
});

describe('selectPage', () => {
  it('picks the page with the strongest case and keeps its queries', () => {
    seedPages('preise', 'kontakt');
    const rows = [
      { url: 'https://acme.io/preise', query: 'preise', position: 2, impressions: 100, clicks: 0 },
      { url: 'https://acme.io/preise', query: 'was kostet', position: 4, impressions: 40, clicks: 0 },
      { url: 'https://acme.io/kontakt', query: 'kontakt', position: 12, impressions: 90, clicks: 2 },
    ];

    const page = selectPage({ rows, config, cwd });

    expect(page.slug).toBe('preise');
    expect(page.kind).toBe('snippet');
    expect(page.impressions).toBe(140);
    expect(page.queries[0].query).toBe('preise');
  });

  it('ignores urls from other hosts of a domain property', () => {
    seedPages('preise');
    const rows = [
      { url: 'https://other.acme.io/preise', query: 'x', position: 2, impressions: 900, clicks: 0 },
    ];
    expect(selectPage({ rows, config, cwd })).toBeNull();
  });

  it('ignores urls that are not landing pages', () => {
    seedPages('preise');
    const rows = [
      { url: 'https://acme.io/impressum', query: 'impressum', position: 1, impressions: 500, clicks: 0 },
    ];
    expect(selectPage({ rows, config, cwd })).toBeNull();
  });

  it('skips slugs inside the cooldown window', () => {
    seedPages('preise', 'kontakt');
    const rows = [
      { url: 'https://acme.io/preise', query: 'preise', position: 2, impressions: 500, clicks: 0 },
      { url: 'https://acme.io/kontakt', query: 'kontakt', position: 11, impressions: 60, clicks: 0 },
    ];

    const page = selectPage({ rows, config, cwd, cooldown: new Set(['preise']) });

    expect(page.slug).toBe('kontakt');
  });

  it('returns null when nothing clears the impression floor', () => {
    seedPages('preise');
    const rows = [{ url: 'https://acme.io/preise', query: 'x', position: 2, impressions: 5, clicks: 0 }];
    expect(selectPage({ rows, config, cwd })).toBeNull();
  });
});

describe('improvement history', () => {
  it('puts a recorded slug into cooldown and lets an old one out again', () => {
    const data = loadImprovements(cwd);
    recordImprovement(data, { slug: 'preise', queries: ['preise'] });
    data.entries.push({ slug: 'alt', date: '2020-01-01', queries: [] });

    const cooling = slugsInCooldown(data);

    expect(cooling.has('preise')).toBe(true);
    expect(cooling.has('alt')).toBe(false);
  });
});
