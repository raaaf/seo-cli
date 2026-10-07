// Duplicate-block detection between landing pages.
//
// `cannibalization.js` counts Search Console rankings per query; it cannot see
// that two pages carry the same paragraph. This compares text: the share of a
// paragraph's word 5-shingles that also occur in one paragraph of another page.

import { STRICT_THRESHOLDS } from './seo-thresholds.js';

const SHINGLE_SIZE = 5;

function words(text) {
  return String(text).toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Prose paragraphs of a markdown body: no headings, nothing under the minimum length. */
export function paragraphs(body, minWords = STRICT_THRESHOLDS.overlapMinWords) {
  return String(body).split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p && !p.startsWith('#') && words(p).length >= minWords);
}

export function shingles(text) {
  const w = words(text);
  const set = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= w.length; i++) set.add(w.slice(i, i + SHINGLE_SIZE).join(' '));
  return set;
}

/** Share of `a`'s shingles that also occur in `b`, 0 to 1. */
export function shingleShare(a, b) {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  return shared / a.size;
}

/**
 * Paragraphs of `body` that duplicate a paragraph of one of `pages` ({ slug, body }).
 * Returns [{ slug, share, excerpt }], one entry per duplicated paragraph.
 */
export function findDuplicateBlocks(body, pages, threshold = STRICT_THRESHOLDS.overlapShare) {
  const hits = [];
  const others = pages.map(p => ({ slug: p.slug, paras: paragraphs(p.body).map(shingles) }));
  for (const para of paragraphs(body)) {
    const mine = shingles(para);
    let best = null;
    for (const other of others) {
      for (const theirs of other.paras) {
        const share = shingleShare(mine, theirs);
        if (share >= threshold && (!best || share > best.share)) best = { slug: other.slug, share };
      }
    }
    if (best) hits.push({ ...best, excerpt: para.replace(/\s+/g, ' ').slice(0, 60) });
  }
  return hits;
}
