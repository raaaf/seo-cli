import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { format } from './date.js';

export const CHANGES_FILE = 'seo/changes.json';

/**
 * Ledger of every merged seo PR: `{ id (PR url), kind: 'new' | 'rewrite', slug,
 * urls, pr_url, merged_at, baseline, readings: { d28, d56 }, revert_candidate }`.
 * A corrupt file throws instead of reading as empty, so the next save cannot
 * wipe the history.
 */
export function loadChanges(cwd = process.cwd()) {
  const path = join(cwd, CHANGES_FILE);
  if (!existsSync(path)) return { version: 1, updated: null, entries: [] };
  try {
    return { version: 1, updated: null, entries: [], ...JSON.parse(readFileSync(path, 'utf8')) };
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

/** Adds the entry unless its id exists; an existing entry, with its readings, is never overwritten. Returns whether it was added. */
export function upsertEntry(data, entry) {
  if (data.entries.some(e => e.id === entry.id)) return false;
  data.entries.push(entry);
  return true;
}
