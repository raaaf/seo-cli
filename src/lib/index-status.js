import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { google } from 'googleapis';
import { getAuth, rethrowWithAuthHint } from './gsc.js';
import { format } from './date.js';

export const INDEX_STATUS_FILE = 'seo/index-status.json';

// Google's URL Inspection API is quota-limited (~2000 inspections/day per
// property) and bursts get 429s. A fixed gap between calls keeps a normal-sized
// sitemap (well under the daily quota) from tripping the burst limiter.
const INSPECTION_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(e) {
  const status = e?.code || e?.response?.status;
  return status === 429 || /quota/i.test(String(e?.message || ''));
}

/**
 * Inspects each URL's index status sequentially via the Search Console API.
 * Stops on a quota error and marks the remaining URLs `unknown` rather than
 * throwing away what was already fetched — a partial snapshot still shows
 * whether pages dropped out of the index.
 */
export async function fetchIndexStatus(config, urls, delayMs = INSPECTION_DELAY_MS) {
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (i > 0) await sleep(delayMs);
    try {
      const res = await sc.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl: config.gsc_property },
      });
      const r = res.data.inspectionResult?.indexStatusResult ?? {};
      results.push({
        url,
        coverageState: r.coverageState ?? null,
        lastCrawlTime: r.lastCrawlTime ?? null,
        verdict: r.verdict ?? null,
        robotsTxtState: r.robotsTxtState ?? null,
        indexingState: r.indexingState ?? null,
      });
    } catch (e) {
      if (isQuotaError(e)) {
        for (const remaining of urls.slice(i)) {
          results.push({ url: remaining, coverageState: 'unknown', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null });
        }
        break;
      }
      rethrowWithAuthHint(e);
    }
  }
  return results;
}

export function loadIndexStatus(cwd = process.cwd()) {
  const path = join(cwd, INDEX_STATUS_FILE);
  if (!existsSync(path)) return { version: 1, updated: null, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { version: 1, updated: null, entries: [], ...parsed };
  } catch {
    return { version: 1, updated: null, entries: [] };
  }
}

/**
 * Writes the snapshot. An `unknown` entry (quota ran out) never replaces the
 * previous entry for that URL, and an entry whose verdict fields are unchanged
 * keeps the previous one (and with it the old `lastCrawlTime`). `updated` only
 * moves when the entries do, so an unchanged daily snapshot stays byte-identical
 * and is not committed again.
 */
export function saveIndexStatus(data, cwd = process.cwd()) {
  const path = join(cwd, INDEX_STATUS_FILE);
  const previous = loadIndexStatus(cwd);
  const previousByUrl = new Map(previous.entries.map(e => [e.url, e]));
  // Only the verdict fields count as a change: a recrawl moves lastCrawlTime alone
  // and must not make a state commit every day.
  const verdictOf = ({ lastCrawlTime: _crawled, ...verdict }) => JSON.stringify(verdict);
  data.entries = data.entries.map((e) => {
    const prev = previousByUrl.get(e.url);
    if (!prev) return e;
    return e.coverageState === 'unknown' || verdictOf(prev) === verdictOf(e) ? prev : e;
  });
  const unchanged = previous.updated && JSON.stringify(previous.entries) === JSON.stringify(data.entries);
  data.updated = unchanged ? previous.updated : format(new Date());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// The exact wording is Google's, not ours, and has drifted before: a page is
// "not indexed" when coverageState starts with one of
//   - "Crawled - currently not indexed"
//   - "Discovered - currently not indexed"
//   - "URL is unknown to Google"
// Anything else (e.g. "Submitted and indexed") counts as indexed.
const NOT_INDEXED_PREFIXES = [
  'Crawled - currently not indexed',
  'Discovered - currently not indexed',
  'URL is unknown to Google',
];

export function isIndexed(coverageState) {
  const state = String(coverageState ?? '');
  return !NOT_INDEXED_PREFIXES.some(prefix => state.startsWith(prefix));
}

/**
 * Compares two snapshots by URL. With no previous snapshot (first run), every
 * URL is a baseline rather than "newly dropped" — otherwise day one always
 * reports a mass deindexing that never happened.
 */
export function diffIndexStatus(previous, current) {
  const result = { newlyIndexed: [], newlyDropped: [], stillMissing: [], unchanged: 0 };
  const previousByUrl = new Map((previous?.entries ?? []).map(e => [e.url, e]));

  for (const entry of current) {
    // No entry for this URL last time (including the very first run, when
    // `previous` has no entries at all) — nothing to compare against, so it
    // cannot be "newly dropped".
    const prev = previousByUrl.get(entry.url);
    const nowIndexed = isIndexed(entry.coverageState);

    if (!prev) {
      result.unchanged++;
      continue;
    }

    const wasIndexed = isIndexed(prev.coverageState);
    if (nowIndexed && !wasIndexed) {
      result.newlyIndexed.push(entry.url);
    } else if (!nowIndexed && wasIndexed) {
      result.newlyDropped.push(entry.url);
    } else if (!nowIndexed && !wasIndexed) {
      result.stillMissing.push(entry.url);
    } else {
      result.unchanged++;
    }
  }

  return result;
}
