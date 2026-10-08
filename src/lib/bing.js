import { safeFetch } from './safe-fetch.js';

// Bing Webmaster API client. The key travels as a query parameter, so every
// failure is repackaged into a BingError with a fixed message: the messages of
// safeFetch (redirect loops, invalid URLs) carry the full URL including the key.

const BASE_URL = 'https://ssl.bing.com/webmaster/api.svc/json/';
const TIMEOUT_MS = 15_000;
// After this many failures in a row a run stops calling Bing.
const MAX_FAILURES = 2;
// Bing reports a bad key as HTTP 400 with this ErrorCode (measured 2026-10-08).
const INVALID_API_KEY = 3;
// Bing answers "never crawled" with year 0001; anything before 2000 is that.
const EARLIEST_MS = Date.UTC(2000, 0, 1);

export class BingError extends Error {
  constructor({ method, kind, status = null }) {
    super(`Bing ${method} failed (${kind}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'BingError';
    this.method = method;
    this.kind = kind;
    this.status = status;
  }
}

// Epoch milliseconds of '/Date(ms)/' (an optional zone offset is ignored), null when malformed or before 2000.
export function parseBingMs(value) {
  const ms = Number(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(String(value ?? ''))?.[1]);
  return Number.isFinite(ms) && ms >= EARLIEST_MS ? ms : null;
}

/** ISO date (UTC) of '/Date(ms)/', null for malformed input and for dates before 2000 (never crawled). */
export function parseBingDate(value) {
  const ms = parseBingMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/** The site as Bing knows it: `bing.site_url`, else `base_url` with exactly one trailing slash. */
export function siteUrl(config) {
  return config.bing?.site_url || `${String(config.base_url).replace(/\/+$/, '')}/`;
}

/** URL as compared with Bing's answers: trailing slashes dropped, lower case. */
export const normalizeUrl = (url) => String(url).replace(/\/+$/, '').toLowerCase();

const sameSite = (a, b) => normalizeUrl(a) === normalizeUrl(b);

/** Whether the `GetUserSites` answer lists `site` (trailing slash and case ignored). */
export const knowsSite = (sites, site) => sites.some(s => sameSite(s.Url, site));

const guard = { failures: 0, last: null };

/** Clears the failure guard (tests). */
export function resetBingGuard() {
  guard.failures = 0;
  guard.last = null;
}

async function failureKind(res) {
  if (res.status === 401 || res.status === 403) return 'key_rejected';
  if (res.status === 429) return 'rate_limited';
  if (res.status >= 500) return 'unavailable';
  if (res.status === 400) {
    try {
      if (JSON.parse(await res.text())?.ErrorCode === INVALID_API_KEY) return 'key_rejected';
    } catch { /* not JSON: a plain error */ }
  }
  return 'error';
}

async function request(method, params) {
  const url = new URL(method, BASE_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('apikey', process.env.BING_WEBMASTER_KEY);
  let res;
  try {
    res = await safeFetch(url.href, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BingError({ method, kind: 'unavailable' });
  }
  if (!res.ok) throw new BingError({ method, kind: await failureKind(res), status: res.status });
  try {
    return (await res.json()).d;
  } catch {
    throw new BingError({ method, kind: 'error', status: res.status });
  }
}

/**
 * GET of one Bing Webmaster method, returns the `d` field. Throws BingError only.
 * `key_rejected` or two failures in a row end the Bing calls of this process.
 */
export async function bingRequest(method, params = {}) {
  if (guard.failures >= MAX_FAILURES) throw new BingError({ method, ...guard.last });
  try {
    const data = await request(method, params);
    guard.failures = 0;
    return data;
  } catch (e) {
    guard.failures = e.kind === 'key_rejected' ? MAX_FAILURES : guard.failures + 1;
    guard.last = { kind: e.kind, status: e.status };
    throw e;
  }
}

export const getUserSites = () => bingRequest('GetUserSites');
export const getQueryStats = (site) => bingRequest('GetQueryStats', { siteUrl: site });
export const getCrawlIssues = (site) => bingRequest('GetCrawlIssues', { siteUrl: site });
export const getUrlInfo = (site, url) => bingRequest('GetUrlInfo', { siteUrl: site, url });

/** Crawled means a real LastCrawledDate; HttpStatus 0 is no error. */
export const isCrawled = (info) => parseBingDate(info?.LastCrawledDate) !== null;
