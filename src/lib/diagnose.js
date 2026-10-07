import { safeFetch } from './safe-fetch.js';
import { stripHtml } from './site-fetch.js';

// Technical diagnosis of a URL Google does not index. `diagnoseUrl` is pure; the
// live fetch is `fetchForDiagnosis`. Findings come from two sources: `live` (our
// own fetch as Googlebot) and `google` (the last crawl according to the URL
// Inspection API, possibly stale). Only live findings decide the `cause`.

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 500000;
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const MIN_WORDS = 50;

// effect: `technical` (a fault that keeps the page out), `unknown` (we cannot tell), `hint` (informs only).
const CODES = {
  not_found: { source: 'live', effect: 'technical', fix: 'The URL answers 404 or 410. Restore the page or remove it from the sitemap.' },
  server_error: { source: 'live', effect: 'unknown', fix: 'The server answers with a 5xx error. Check the server logs; the result is not trusted until the fetch works.' },
  blocked_for_bot: { source: 'live', effect: 'unknown', fix: 'The server refuses the crawler request (401, 403 or 429). Check the firewall and bot protection for Googlebot.' },
  http_error: { source: 'live', effect: 'technical', fix: 'The URL answers with an HTTP error status. Make it answer 200.' },
  redirect: { source: 'live', effect: 'technical', fix: 'The URL redirects elsewhere. Link and list the final URL in the sitemap instead.' },
  noindex_header: { source: 'live', effect: 'technical', fix: 'The X-Robots-Tag header contains noindex. Remove it from the server or CDN configuration.' },
  noindex_meta: { source: 'live', effect: 'technical', fix: 'The robots meta tag contains noindex. Remove it from the page template.' },
  canonical_other: { source: 'live', effect: 'technical', fix: 'The canonical link points to a different URL. Point it at the page itself.' },
  robots_unreachable: { source: 'live', effect: 'technical', fix: 'robots.txt answers with a 5xx error, which can stop Google from crawling at all. Make it answer 200 or 404.' },
  no_text: { source: 'live', effect: 'hint', fix: 'The served HTML has almost no visible text. Render the content on the server, not only in JavaScript.' },
  google_canonical_other: { source: 'google', effect: 'hint', fix: 'Google chose another canonical for this page. Check for duplicate or near-duplicate content and consolidate.' },
  robots_blocked: { source: 'google', effect: 'hint', fix: 'Google saw the URL blocked by robots.txt at the last crawl. Allow it in robots.txt.' },
  google_fetch_failed: { source: 'google', effect: 'hint', fix: 'Google could not fetch the page at the last crawl. Check availability and response time.' },
  soft_404: { source: 'google', effect: 'hint', fix: 'Google treats the page as a soft 404 (thin or empty content). Add substantial content to the page.' },
  fetch_failed: { source: 'live', effect: 'unknown', fix: 'The live fetch failed (DNS, timeout or connection). The result is not trusted until the fetch works.' },
};

// Scheme and host lowercase, no www., no trailing slash, no fragment, query kept.
function normalizeUrl(href, base) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** True when two URLs are the same page for indexing purposes. A relative `a` resolves against `base`. */
export function sameUrl(a, b, base) {
  const left = normalizeUrl(a, base);
  return left !== null && left === normalizeUrl(b, base);
}

/** Fetches a page the way Googlebot would. Returns `{ status, finalUrl, headers, html }`; throws on DNS, timeout and the like. */
export async function fetchForDiagnosis(url, { locale } = {}) {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': GOOGLEBOT_UA, ...(locale ? { 'Accept-Language': locale } : {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  return { status: res.status, finalUrl: res.url || url, headers: Object.fromEntries(res.headers), html };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

const hasNoindex = (value) => /noindex/i.test(value ?? '');

// One header value (several headers arrive joined by ","). `name: directive` addresses one bot and
// holds for the directives after it, so only a googlebot prefix or none counts.
function headerNoindex(value) {
  return String(value ?? '').split('\n').some((line) => {
    let applies = true;
    return line.split(',').some((part) => {
      const m = part.match(/^\s*([a-z][\w-]*)\s*:\s*(.*)$/i);
      if (m && m[1].toLowerCase() !== 'unavailable_after') {
        applies = m[1].toLowerCase() === 'googlebot';
        return applies && hasNoindex(m[2]);
      }
      return applies && hasNoindex(part);
    });
  });
}

function metaNoindex(html) {
  return (html.match(/<meta\b[^>]*>/gi) ?? []).some(tag =>
    /^(robots|googlebot)$/i.test(attr(tag, 'name') ?? '') && hasNoindex(attr(tag, 'content')));
}

function canonicalHref(html) {
  const tag = (html.match(/<link\b[^>]*>/gi) ?? []).find(t => /\bcanonical\b/i.test(attr(t, 'rel') ?? ''));
  return tag ? attr(tag, 'href') : null;
}

// Plain comparison: Google reports /x to /x/ and apex to www as "Page with redirect" too.
function redirected(url, finalUrl) {
  try {
    return new URL(finalUrl).href !== new URL(url).href;
  } catch {
    return finalUrl !== url;
  }
}

// Each finding is [code, detail].
function liveFindings({ url, response, fetchError, robotsStatus }) {
  if (!response) {
    const detail = String(fetchError ?? '').split('\n')[0] || 'no response';
    return [[detail.startsWith('Too many redirects') ? 'redirect' : 'fetch_failed', detail]];
  }
  const { status, finalUrl, headers, html } = response;
  const found = [];

  if (status === 404 || status === 410) found.push(['not_found', `HTTP ${status}`]);
  else if (status >= 500) found.push(['server_error', `HTTP ${status}`]);
  else if ([401, 403, 429].includes(status)) found.push(['blocked_for_bot', `HTTP ${status}`]);
  else if (status >= 400) found.push(['http_error', `HTTP ${status}`]);

  if (redirected(url, finalUrl)) found.push(['redirect', `ends at ${finalUrl}`]);
  if (headerNoindex(headers?.['x-robots-tag'])) found.push(['noindex_header', headers['x-robots-tag']]);
  if (status < 400) {
    if (metaNoindex(html)) found.push(['noindex_meta', 'robots meta tag']);
    const canonical = canonicalHref(html);
    if (canonical && !sameUrl(canonical, url, finalUrl)) found.push(['canonical_other', canonical]);
  }
  if (robotsStatus >= 500) found.push(['robots_unreachable', `robots.txt HTTP ${robotsStatus}`]);
  if (status === 200 && stripHtml(html).split(/\s+/).filter(Boolean).length < MIN_WORDS) found.push(['no_text', `under ${MIN_WORDS} words`]);
  return found;
}

function googleFindings({ url, inspection }) {
  const found = [];
  if (!inspection) return found;
  if (inspection.googleCanonical && !sameUrl(inspection.googleCanonical, url)) found.push(['google_canonical_other', inspection.googleCanonical]);
  if (inspection.robotsTxtState === 'DISALLOWED') found.push(['robots_blocked', 'DISALLOWED']);
  const fetchState = inspection.pageFetchState;
  if (fetchState === 'SOFT_404') found.push(['soft_404', fetchState]);
  else if (fetchState && fetchState !== 'SUCCESSFUL' && fetchState !== 'PAGE_FETCH_STATE_UNSPECIFIED') found.push(['google_fetch_failed', fetchState]);
  return found;
}

/**
 * Pure diagnosis of one URL. `response` is the result of `fetchForDiagnosis`
 * (null when the fetch threw, then `fetchError` carries the message), `robotsStatus` the status of robots.txt (null
 * when unknown). `cause` is `technical` when a live finding with a technical
 * effect applies, else `unknown` when a finding says we cannot tell or the
 * inspection entry is missing or unknown, else `clean`. Google findings never
 * decide: they can linger until the next crawl after a fix.
 */
export function diagnoseUrl({ url, inspection, response, fetchError, robotsStatus }) {
  const found = [...liveFindings({ url, response, fetchError, robotsStatus }), ...googleFindings({ url, inspection })];
  const findings = found.map(([code, detail]) => ({ code, source: CODES[code].source, detail, fix: CODES[code].fix }));
  const effects = found.map(([code]) => CODES[code].effect);

  let cause = 'clean';
  if (effects.includes('technical')) cause = 'technical';
  else if (effects.includes('unknown') || !inspection || inspection.coverageState === 'unknown') cause = 'unknown';
  return { cause, findings };
}
