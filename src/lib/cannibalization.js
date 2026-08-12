// Cannibalization guard.
//
// The two existing guards ask whether a keyword *reads* like something we cover:
// `similarity.js` compares token sets, the scoring prompt returns `covered_by`.
// Neither sees what Search Console already knows. "betriebsfeier organisieren"
// and "firmenfeier planen" share no token and read as two topics, but on
// 2026-08-12 three of our own pages ranked for the first query, all of them past
// position 60. A fourth page for that query is not a gap, it is more of the same.
//
// This guard reads the page/query rows we already fetch and counts how many of
// our own landing pages appear on the candidate's query. It only judges the
// query the candidate actually is: a word-order variant counts, anything fuzzier
// stays with the model.

import { isSameTokenSet } from './similarity.js';

/** Slug of a landing URL, or null: "https://x.de/de/foo?a=1" -> "foo". */
export function slugFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

/**
 * Our own landing pages that already rank for `keyword`, strongest first.
 *
 * `pageRows` are Search Console rows with `keys: [page, query]`. `landingSlugs`
 * limits the count to landing pages: the home page, /preise and /hilfe show up
 * on the same queries by design and are not cannibalization.
 */
export function competingPages(keyword, pageRows = [], landingSlugs = []) {
  const slugs = new Set(landingSlugs);
  const bySlug = new Map();

  for (const row of pageRows) {
    const [page, query] = row.keys || [];
    if (!page || !query) continue;
    if (!isSameTokenSet(keyword, query)) continue;

    const slug = slugFromUrl(page);
    if (!slug || !slugs.has(slug)) continue;

    const seen = bySlug.get(slug);
    if (!seen || row.impressions > seen.impressions) {
      bySlug.set(slug, { slug, impressions: row.impressions, position: row.position });
    }
  }

  return [...bySlug.values()].sort((a, b) => b.impressions - a.impressions);
}

/**
 * True when the query is already contested by `threshold` or more of our pages.
 * Two is the point where the pages measurably hold each other down.
 */
export function isCannibalized(keyword, pageRows, landingSlugs, threshold = 2) {
  return competingPages(keyword, pageRows, landingSlugs).length >= threshold;
}

/** "firmenfeier-planen (pos 66.7), betriebsausflug-planen (pos 89.6)" */
export function describeCompetitors(pages) {
  return pages.map(p => `${p.slug} (pos ${p.position.toFixed(1)})`).join(', ');
}
