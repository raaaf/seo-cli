import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { format } from './date.js';

export const KEYWORDS_FILE = 'seo/keywords.json';
export const SITEMAP_PENDING_FILE = 'seo/sitemap-pending.json';

export const KEYWORD_STATUS = {
  PROPOSED: 'proposed',
  DONE: 'done',
  SKIP: 'skip',
  PR_OPENED: 'pr_opened',
  PUBLISHED: 'published', // its PR was merged
  REJECTED: 'rejected', // its PR was closed without merging
  VALIDATION_FAILED: 'validation_failed',
};

// A valid landing-page slug: lowercase alphanumerics and hyphens, must start
// with an alphanumeric. Used to validate LLM-returned slugs before any FS use.
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;
export function isValidSlug(slug) {
  return SLUG_REGEX.test(String(slug ?? ''));
}

export function loadKeywords(cwd = process.cwd()) {
  const path = join(cwd, KEYWORDS_FILE);
  if (!existsSync(path)) return { version: 1, keywords: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${KEYWORDS_FILE}: ${e.message}`, { cause: e });
  }
}

export function saveKeywords(data, cwd = process.cwd()) {
  const path = join(cwd, KEYWORDS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  data.updated = format(new Date());
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function upsertKeyword(data, incoming) {
  const idx = data.keywords.findIndex(k => k.keyword === incoming.keyword);
  if (idx >= 0) {
    data.keywords[idx] = { ...data.keywords[idx], ...incoming };
  } else {
    data.keywords.push(incoming);
  }
}

// Order in which proposed keywords are worked off: the score, minus 2 for an
// informational keyword whose SERP shows an AI Overview that does not cite us
// (clicks drop there). The stored score stays untouched: AI Overviews come and
// go, and a lowered score would push the keyword under the cutoff for good.
export function serpPriority(keyword) {
  const f = keyword.serp_features;
  const penalised = keyword.intent === 'informational' && f?.ai_overview && !f.ai_overview_cites_us;
  return keyword.score - (penalised ? 2 : 0);
}

export function getPending(data, scoreCutoff) {
  return data.keywords
    .filter(k => k.status === KEYWORD_STATUS.PROPOSED && k.score >= scoreCutoff)
    .sort((a, b) => serpPriority(b) - serpPriority(a));
}

// New-page PRs opened in the calendar month of `now`: open or merged, not
// closed-unmerged. Keywords without pr_opened_at are not counted.
export function newPagesThisMonth(data, now = new Date()) {
  const month = format(now).slice(0, 7);
  return data.keywords.filter(k =>
    (k.status === KEYWORD_STATUS.PR_OPENED || k.status === KEYWORD_STATUS.PUBLISHED)
    && k.pr_opened_at?.startsWith(month)
  ).length;
}

// A keyword marked pr_opened that never got a PR (it failed, was skipped, or the
// run broke before the PRs) goes back to proposed. Entries that already carry a
// pr_url are left alone, they are reconciled against the real PR state.
export function releasePending(keywords) {
  for (const kw of keywords) {
    if (kw.status === KEYWORD_STATUS.PR_OPENED && !kw.pr_url) kw.status = KEYWORD_STATUS.PROPOSED;
  }
}

export function loadSitemapPending(cwd = process.cwd()) {
  const path = join(cwd, SITEMAP_PENDING_FILE);
  if (!existsSync(path)) return { updated: null, slugs: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { updated: null, slugs: [] }; }
}

export function saveSitemapPending(data, cwd = process.cwd()) {
  const path = join(cwd, SITEMAP_PENDING_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
