// Bing query adapter: pure parts (aggregation, privacy filter, matching) plus
// the weekly refresh in `seo run`. Queries live in the signal store, keyed by
// site; the crawl checks of the watcher are live and never cached.

import { getUserSites, getQueryStats, siteUrl, parseBingMs, knowsSite } from '../bing.js';
import { classifyQuery } from '../conversational.js';
import { tokenize } from '../similarity.js';
import { getFresh, putSignal } from './store.js';

export const BING_SIGNALS_NAME = 'bing';
const TTL_DAYS = 7;
const WINDOW_DAYS = 180;
const MAX_QUERIES = 200;
const MAX_QUERY_LENGTH = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

const bingQueriesKey = (config) => `queries:${siteUrl(config)}`;

/**
 * Weekly rows (`Query`, `Impressions`, `Clicks`, `AvgImpressionPosition`, `Date`) to one entry per
 * query (case-insensitive): counts summed, position weighted by impressions and rounded to one
 * decimal, rows older than `days` dropped, most impressions first.
 */
export function aggregateQueries(rows, { now = new Date(), days = WINDOW_DAYS, limit = MAX_QUERIES } = {}) {
  const cutoff = now.getTime() - days * DAY_MS;
  const byQuery = new Map();
  for (const row of rows) {
    const query = String(row.Query ?? '').trim().toLowerCase();
    const at = parseBingMs(row.Date);
    if (!query || at === null || at < cutoff || !(row.Impressions > 0) || typeof row.AvgImpressionPosition !== 'number') continue;
    const agg = byQuery.get(query) ?? { query, impressions: 0, clicks: 0, weighted: 0 };
    agg.impressions += row.Impressions;
    agg.clicks += row.Clicks ?? 0;
    agg.weighted += row.Impressions * row.AvgImpressionPosition;
    byQuery.set(query, agg);
  }
  return [...byQuery.values()]
    .map(({ weighted, ...agg }) => ({ ...agg, position: Math.round((weighted / agg.impressions) * 10) / 10 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

const EMAIL = /@/;
const LONG_DIGITS = /\d{6,}/;
// +49..., 0049..., or a leading 0 area code followed by a separator and the number.
const PHONE = /(?:\+|\b00|\b0\d{2,4}[\s\-/])[\d\s\-/()]{7,}/;

/** Drops queries that may hold personal data (email, long digit run, phone number, over 120 characters) and tracker probes or artefacts. */
export function filterQueries(queries) {
  return queries.filter(({ query }) => {
    if (query.length > MAX_QUERY_LENGTH || EMAIL.test(query) || LONG_DIGITS.test(query) || PHONE.test(query)) return false;
    return !['tracker_probe', 'artefact'].includes(classifyQuery(query));
  });
}

/** Stored queries that contain every significant token of `keyword`, most impressions first, at most `max`. */
export function bingQuestionsFor(keyword, queries, { max = 8 } = {}) {
  const wanted = [...tokenize(keyword)];
  if (!wanted.length) return [];
  return queries
    .filter(q => { const tokens = tokenize(q.query); return wanted.every(t => tokens.has(t)); })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, max)
    .map(q => q.query);
}

/** Start mode candidates in the shape of GSC rows: positions 8 to 25 like the GSC candidates, at least `max(5, min_impressions)` impressions. */
export function bingCandidates(queries, config) {
  const floor = Math.max(5, config.min_impressions ?? 5);
  return queries
    .filter(q => q.position >= 8 && q.position <= 25 && q.impressions >= floor)
    .map(({ query, ...rest }) => ({ keyword: query, ...rest }))
    .sort((a, b) => b.impressions - a.impressions);
}

const isValidQueries = (v) => Array.isArray(v) && v.every(q => q && typeof q.query === 'string'
  && [q.impressions, q.clicks, q.position].every(n => typeof n === 'number'));

const freshQueries = (config, cwd) => getFresh(BING_SIGNALS_NAME, bingQueriesKey(config), TTL_DAYS, new Date(), { cwd, validate: isValidQueries });

/** Stored queries of the site, empty without `bing.enabled` or without a fresh entry. */
export function readBingQueries(config, cwd) {
  if (!config.bing?.enabled) return [];
  return freshQueries(config, cwd) ?? [];
}

/**
 * Refreshes the stored queries when older than 7 days (`seo run`). Never throws: no key, a site
 * Bing does not know or a Bing error is a warning and leaves the old entry.
 */
export async function refreshBingQueries({ config, cwd, warnings, now = new Date() }) {
  if (!config.bing?.enabled || freshQueries(config, cwd) !== null) return;
  if (!process.env.BING_WEBMASTER_KEY) {
    warnings.push('bing.enabled is set but BING_WEBMASTER_KEY is missing, skipping Bing queries');
    return;
  }
  const site = siteUrl(config);
  try {
    if (!knowsSite(await getUserSites(), site)) {
      warnings.push(`Bing does not know ${site}, skipping Bing queries`);
      return;
    }
    const queries = filterQueries(aggregateQueries(await getQueryStats(site), { now, limit: Infinity })).slice(0, MAX_QUERIES);
    putSignal(BING_SIGNALS_NAME, bingQueriesKey(config), queries, now, { cwd, ttlDays: TTL_DAYS });
  } catch (e) {
    warnings.push(`Bing queries not refreshed: ${e.message}`);
  }
}
