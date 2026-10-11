import { assertPublicUrl } from './safe-fetch.js';

// Rybbit analytics API client (self-hosted). The key travels as a Bearer header, so every
// failure is repackaged into a RybbitError with a fixed message, and redirects are never
// followed: safeFetch would hand the header on to whatever host the Location names.

const TIMEOUT_MS = 15_000;
const TIME_ZONE = 'Europe/Berlin';
// After this many failures in a row a run stops calling Rybbit.
const MAX_FAILURES = 2;

// Referrer hosts of AI search products. A lower bound: many AI visits arrive without a referrer.
export const AI_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'www.perplexity.ai', 'claude.ai',
  'gemini.google.com', 'copilot.microsoft.com', 'copilot.com',
];

export class RybbitError extends Error {
  constructor({ method, kind, status = null }) {
    super(`Rybbit ${method} failed (${kind}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'RybbitError';
    this.method = method;
    this.kind = kind;
    this.status = status;
  }
}

const guard = { failures: 0, last: null };

/** Clears the failure guard (tests). */
export function resetRybbitGuard() {
  guard.failures = 0;
  guard.last = null;
}

function failureKind(status) {
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'error';
}

function endpoint(config, method) {
  const { url, site_id: siteId } = config.rybbit;
  let base;
  try {
    base = new URL(`${String(url).replace(/\/+$/, '')}/`);
  } catch {
    throw new RybbitError({ method, kind: 'error' });
  }
  if (base.protocol !== 'https:') throw new RybbitError({ method, kind: 'error' });
  return new URL(`api/sites/${encodeURIComponent(siteId)}/${method}`, base);
}

async function request(config, method, params) {
  const url = endpoint(config, method);
  for (const [name, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(name, value);
  }
  url.searchParams.set('time_zone', TIME_ZONE);
  let res;
  try {
    await assertPublicUrl(url.href);
    res = await fetch(url.href, {
      headers: { Authorization: `Bearer ${process.env.RYBBIT_API_KEY}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RybbitError({ method, kind: 'unavailable' });
  }
  // Any 3xx is an error: following it would send the key to another host.
  if (res.status >= 300) throw new RybbitError({ method, kind: failureKind(res.status), status: res.status });
  try {
    return await res.json();
  } catch {
    throw new RybbitError({ method, kind: 'error', status: res.status });
  }
}

/**
 * One Rybbit GET, returns the parsed body. Throws RybbitError only.
 * `key_rejected` or two failures in a row end the Rybbit calls of this process.
 */
export async function rybbitRequest(config, method, params = {}) {
  if (guard.failures >= MAX_FAILURES) throw new RybbitError({ method, ...guard.last });
  try {
    const body = await request(config, method, params);
    guard.failures = 0;
    return body;
  } catch (e) {
    const err = e instanceof RybbitError ? e : new RybbitError({ method, kind: 'error' });
    guard.failures = err.kind === 'key_rejected' ? MAX_FAILURES : guard.failures + 1;
    guard.last = { kind: err.kind, status: err.status };
    throw err;
  }
}

const filter = (parameter, values) => JSON.stringify([{ parameter, type: 'equals', value: values }]);
const windowParams = (w) => ({ start_date: w.startDate, end_date: w.endDate });
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Only the fields the signals use are kept, so the cache stays small.
function metricRows(method, body) {
  const rows = body?.data?.data;
  if (!Array.isArray(rows)) throw new RybbitError({ method, kind: 'error' });
  return rows
    .filter(r => r && typeof r.value === 'string' && num(r.count) !== null)
    .map(r => ({ value: r.value, count: r.count, bounce_rate: num(r.bounce_rate), time_on_page_seconds: num(r.time_on_page_seconds) }));
}

async function metric(config, window, parameter, filters) {
  const body = await rybbitRequest(config, 'metric', { parameter, ...windowParams(window), filters });
  return metricRows('metric', body);
}

/** Entry pages of the window: sessions that began on `value`, with bounce rate and time on page. */
export const entryPages = (config, window) => metric(config, window, 'entry_page');

/** Entry pages of sessions that came from an AI host, by `referrer` or by `utm_source`. */
export const aiEntryPages = (config, window, by) => metric(config, window, 'entry_page', filter(by, AI_HOSTS));

/** The AI sources themselves, by `referrer` or by `utm_source`. */
export const aiSources = (config, window, by) => metric(config, window, by, filter(by, AI_HOSTS));

/**
 * Goals with their conversions in the window. `paths` limits the sessions to those that began
 * on one of the paths (variants of one page); without it the numbers are site-wide.
 */
export async function goalsForEntry(config, window, paths = null) {
  const body = await rybbitRequest(config, 'goals', { ...windowParams(window), filters: paths ? filter('entry_page', paths) : null });
  if (!Array.isArray(body?.data)) throw new RybbitError({ method: 'goals', kind: 'error' });
  return body.data
    .filter(g => g && typeof g.name === 'string')
    .map(g => ({ goalId: g.goalId ?? null, name: g.name, total_conversions: num(g.total_conversions), total_sessions: num(g.total_sessions) }));
}
