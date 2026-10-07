import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { format } from './date.js';

export const CHANGES_FILE = 'seo/changes.json';

/**
 * Ledger of every merged seo PR: `{ id (PR url), kind: 'new' | 'rewrite', slug,
 * urls, pr_url, merged_at, baseline, readings: { d28, d56 }, revert_candidate,
 * unmapped? }`, plus `skipped: [{ id, reason }]` for merged PRs that were read and will
 * never get an entry (no real merge date, too old), so they are not read again.
 * A corrupt file throws instead of reading as empty, so the next save cannot
 * wipe the history.
 */
export function loadChanges(cwd = process.cwd()) {
  const path = join(cwd, CHANGES_FILE);
  if (!existsSync(path)) return { version: 1, updated: null, entries: [], skipped: [] };
  try {
    return { version: 1, updated: null, entries: [], skipped: [], ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    throw new Error(`Failed to parse ${CHANGES_FILE}: ${e.message}`, { cause: e });
  }
}

export function saveChanges(data, cwd = process.cwd()) {
  const path = join(cwd, CHANGES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  data.updated = format(new Date());
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Adds the entry unless its id exists; an existing entry, with its readings, is never overwritten.
 * One exception: a rewrite stored without its counterpart gets the counterpart URL once it is known.
 * Returns whether it was added.
 */
export function upsertEntry(data, entry) {
  const existing = data.entries.find(e => e.id === entry.id);
  if (!existing) {
    data.entries.push(entry);
    return true;
  }
  if (existing.kind === 'rewrite' && existing.urls.length === 1 && entry.urls.length > 1) existing.urls = entry.urls;
  return false;
}

export function markSkipped(data, id, reason) {
  if (!data.skipped.some(s => s.id === id)) data.skipped.push({ id, reason });
}
