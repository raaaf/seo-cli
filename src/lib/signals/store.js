import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// External signals with an expiry date, one file per adapter:
// { version: 1, entries: { [key]: { fetched_at, value } } }.
// Paths are relative to cwd like budget.js: cwd is always the target project.
export const SERP_SIGNALS_FILE = 'seo/signals/serp.json';

const DAY_MS = 24 * 60 * 60 * 1000;

function signalsPath(name, cwd) {
  return join(cwd, 'seo', 'signals', `${name}.json`);
}

function emptyStore() {
  return { version: 1, entries: {} };
}

// A missing file is an empty store. An unreadable one warns and also reads as
// empty: signals are a cache, so the next write replaces it.
export function loadSignals(name, cwd = process.cwd()) {
  const path = signalsPath(name, cwd);
  if (!existsSync(path)) return emptyStore();
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    if (!stored || typeof stored.entries !== 'object' || stored.entries === null || Array.isArray(stored.entries)) {
      throw new Error('unexpected shape');
    }
    return { version: 1, entries: stored.entries };
  } catch (e) {
    console.warn(`Signals file seo/signals/${name}.json unreadable (${e.message}), starting empty`);
    return emptyStore();
  }
}

// Writes only when the serialized content differs from what is on disk.
export function saveSignals(name, store, cwd = process.cwd()) {
  const path = signalsPath(name, cwd);
  const content = JSON.stringify(store, null, 2) + '\n';
  if (existsSync(path)) {
    try { if (readFileSync(path, 'utf8') === content) return false; } catch { /* rewrite below */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return true;
}

// The stored value while it is younger than `ttlDays` and passes `validate`,
// otherwise null (an entry of the wrong shape counts as absent).
export function getFresh(name, key, ttlDays, now = new Date(), { cwd = process.cwd(), validate = () => true } = {}) {
  const entry = loadSignals(name, cwd).entries[key];
  if (!entry) return null;
  const fetchedAt = Date.parse(entry.fetched_at);
  if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt >= ttlDays * DAY_MS) return null;
  return validate(entry.value) ? entry.value : null;
}

// Writes synchronously, so a paid lookup survives a later error in the run.
// Entries older than twice the TTL are dropped on the way.
export function putSignal(name, key, value, now = new Date(), { cwd = process.cwd(), ttlDays } = {}) {
  const store = loadSignals(name, cwd);
  store.entries[key] = { fetched_at: now.toISOString(), value };
  if (ttlDays) {
    for (const [k, entry] of Object.entries(store.entries)) {
      const fetchedAt = Date.parse(entry?.fetched_at);
      if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt >= 2 * ttlDays * DAY_MS) delete store.entries[k];
    }
  }
  saveSignals(name, store, cwd);
}
