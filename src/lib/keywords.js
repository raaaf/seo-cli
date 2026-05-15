import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { format } from './date.js';

export const KEYWORDS_FILE = 'seo/keywords.json';
export const SITEMAP_PENDING_FILE = 'seo/sitemap-pending.json';
export const LAST_PR_FILE = 'seo/last-pr.json';

export const KEYWORD_STATUS = {
  PROPOSED: 'proposed',
  DONE: 'done',
  SKIP: 'skip',
  PR_OPENED: 'pr_opened',
  VALIDATION_FAILED: 'validation_failed',
};

export function loadKeywords(cwd = process.cwd()) {
  const path = join(cwd, KEYWORDS_FILE);
  if (!existsSync(path)) return { version: 1, keywords: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${KEYWORDS_FILE}: ${e.message}`);
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

export function getPending(data, scoreCutoff) {
  return data.keywords.filter(
    k => k.status === KEYWORD_STATUS.PROPOSED && k.score >= scoreCutoff
  );
}

export function saveLastPR(prUrl, cwd = process.cwd()) {
  const path = join(cwd, LAST_PR_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pr_url: prUrl, created_at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}
