import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { format } from './date.js';

export const IMPROVEMENTS_FILE = 'seo/improvements.json';

// Weeks a page is off the improvement list after being rewritten. Long enough
// for Search Console to show whether the rewrite moved anything.
export const COOLDOWN_DAYS = 56;

export function loadImprovements(cwd = process.cwd()) {
  const path = join(cwd, IMPROVEMENTS_FILE);
  if (!existsSync(path)) return { version: 1, updated: null, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { version: 1, updated: null, entries: [], ...parsed };
  } catch {
    return { version: 1, updated: null, entries: [] };
  }
}

export function saveImprovements(data, cwd = process.cwd()) {
  const path = join(cwd, IMPROVEMENTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  data.updated = format(new Date());
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function recordImprovement(data, { slug, queries }) {
  data.entries.push({ slug, date: format(new Date()), queries: queries.slice(0, 5) });
  return data;
}

/** Slugs improved within the cooldown window, relative to `today`. */
export function slugsInCooldown(data, today = new Date()) {
  const cutoff = new Date(today.getTime() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  return new Set(
    (data.entries || [])
      .filter(e => e.date && new Date(e.date) >= cutoff)
      .map(e => e.slug),
  );
}
