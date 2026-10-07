import { describe, it, expect } from 'vitest';
import { sameUrl, diagnoseUrl } from '../src/lib/diagnose.js';

const URL_ = 'https://a.de/page';
const WORDS = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
const page = (head = '') => `<html><head>${head}</head><body><p>${WORDS}</p></body></html>`;
const INSPECTED = { url: URL_, coverageState: 'Crawled - currently not indexed', robotsTxtState: 'ALLOWED', googleCanonical: URL_, pageFetchState: 'SUCCESSFUL' };
const ok = (over = {}) => ({ status: 200, finalUrl: URL_, headers: {}, html: page(), ...over });
const diagnose = (over = {}) => diagnoseUrl({ url: URL_, inspection: INSPECTED, response: ok(), robotsStatus: 200, ...over });
const codes = (result) => result.findings.map(f => f.code);

describe('diagnose: sameUrl', () => {
  it('ignores www, a trailing slash, host case and fragment, and resolves a relative href', () => {
    expect(sameUrl('https://www.A.de/page/', 'https://a.de/page#top')).toBe(true);
    expect(sameUrl('/page', URL_, 'https://a.de/other')).toBe(true);
  });

  it('keeps the query and the path', () => {
    expect(sameUrl('https://a.de/page?x=1', URL_)).toBe(false);
    expect(sameUrl('https://a.de/other', URL_)).toBe(false);
  });
});

describe('diagnose: live findings', () => {
  it('reports 404 and 410 as not_found, technical', () => {
    for (const status of [404, 410]) {
      const result = diagnose({ response: ok({ status }) });
      expect(codes(result)).toEqual(['not_found']);
      expect(result.cause).toBe('technical');
    }
  });

  it('reports a 5xx as server_error, unknown', () => {
    const result = diagnose({ response: ok({ status: 503 }) });
    expect(codes(result)).toEqual(['server_error']);
    expect(result.cause).toBe('unknown');
  });

  it('reports 401, 403 and 429 as blocked_for_bot, unknown', () => {
    for (const status of [401, 403, 429]) {
      const result = diagnose({ response: ok({ status }) });
      expect(codes(result)).toEqual(['blocked_for_bot']);
      expect(result.cause).toBe('unknown');
    }
  });

  it('reports any other 4xx as http_error, technical', () => {
    const result = diagnose({ response: ok({ status: 400 }) });
    expect(codes(result)).toEqual(['http_error']);
    expect(result.cause).toBe('technical');
  });

  it('reports a different final URL as redirect, also a slash or www variant', () => {
    for (const finalUrl of ['https://a.de/new', 'https://a.de/page/', 'https://www.a.de/page']) {
      const result = diagnose({ response: ok({ finalUrl }) });
      expect(codes(result)).toEqual(['redirect']);
      expect(result.cause).toBe('technical');
    }
  });

  it('reports no redirect when the final URL only differs in host case or default port', () => {
    expect(codes(diagnose({ response: ok({ finalUrl: 'HTTPS://A.de:443/page' }) }))).toEqual([]);
  });

  it('reports noindex in the X-Robots-Tag header, also for a named bot', () => {
    expect(codes(diagnose({ response: ok({ headers: { 'x-robots-tag': 'googlebot: noindex' } }) }))).toEqual(['noindex_header']);
    expect(codes(diagnose({ response: ok({ headers: { 'x-robots-tag': 'all' } }) }))).toEqual([]);
  });

  it('ignores an X-Robots-Tag noindex addressed to another bot', () => {
    expect(codes(diagnose({ response: ok({ headers: { 'x-robots-tag': 'bingbot: noindex' } }) }))).toEqual([]);
    expect(codes(diagnose({ response: ok({ headers: { 'x-robots-tag': 'bingbot: nofollow, noindex' } }) }))).toEqual([]);
    expect(codes(diagnose({ response: ok({ headers: { 'x-robots-tag': 'bingbot: nofollow, googlebot: noindex' } }) }))).toEqual(['noindex_header']);
  });

  it('does not read data-name or data-content as meta attributes', () => {
    const html = page('<meta data-name="robots" data-content="noindex" name="description" content="x">');
    expect(codes(diagnose({ response: ok({ html }) }))).toEqual([]);
  });

  it('reports noindex in a robots or googlebot meta tag, whatever the attribute order', () => {
    expect(codes(diagnose({ response: ok({ html: page('<meta name="robots" content="noindex, follow">') }) }))).toEqual(['noindex_meta']);
    expect(codes(diagnose({ response: ok({ html: page('<meta content="noindex" name="googlebot">') }) }))).toEqual(['noindex_meta']);
    expect(codes(diagnose({ response: ok({ html: page('<meta name="robots" content="index, follow">') }) }))).toEqual([]);
  });

  it('reports a canonical to another URL, but not a relative or www variant of the page itself', () => {
    const other = diagnose({ response: ok({ html: page('<link rel="canonical" href="https://a.de/other">') }) });
    expect(codes(other)).toEqual(['canonical_other']);
    expect(other.cause).toBe('technical');
    expect(codes(diagnose({ response: ok({ html: page('<link rel="canonical" href="/page/">') }) }))).toEqual([]);
    expect(codes(diagnose({ response: ok({ html: page('<link href="https://www.a.de/page" rel="canonical">') }) }))).toEqual([]);
  });

  it('reports a robots.txt 5xx as robots_unreachable, technical', () => {
    const result = diagnose({ robotsStatus: 503 });
    expect(codes(result)).toEqual(['robots_unreachable']);
    expect(result.cause).toBe('technical');
  });

  it('reports a page under 50 words as no_text, a hint only', () => {
    const result = diagnose({ response: ok({ html: '<html><body><p>just a few words</p></body></html>' }) });
    expect(codes(result)).toEqual(['no_text']);
    expect(result.cause).toBe('clean');
  });

  it('reports a failed fetch as fetch_failed, unknown, with the first line of the error', () => {
    const result = diagnose({ response: null, fetchError: 'getaddrinfo ENOTFOUND a.de\n    at x' });
    expect(codes(result)).toEqual(['fetch_failed']);
    expect(result.findings[0].detail).toBe('getaddrinfo ENOTFOUND a.de');
    expect(result.cause).toBe('unknown');
  });

  it('reports a redirect loop as redirect, technical', () => {
    const result = diagnose({ response: null, fetchError: 'Too many redirects (max 5) from https://a.de/page' });
    expect(codes(result)).toEqual(['redirect']);
    expect(result.findings[0].detail).toMatch(/^Too many redirects/);
    expect(result.cause).toBe('technical');
  });
});

describe('diagnose: google findings', () => {
  it('reports a different Google canonical, robots block, fetch failure and soft 404 as hints', () => {
    const cases = [
      [{ googleCanonical: 'https://a.de/other' }, 'google_canonical_other'],
      [{ robotsTxtState: 'DISALLOWED' }, 'robots_blocked'],
      [{ pageFetchState: 'NOT_FOUND' }, 'google_fetch_failed'],
      [{ pageFetchState: 'SOFT_404' }, 'soft_404'],
    ];
    for (const [over, code] of cases) {
      const result = diagnose({ inspection: { ...INSPECTED, ...over } });
      expect(codes(result)).toEqual([code]);
      expect(result.findings[0].source).toBe('google');
    }
  });

  it('ignores a successful or unspecified fetch state', () => {
    for (const pageFetchState of ['SUCCESSFUL', 'PAGE_FETCH_STATE_UNSPECIFIED', null]) {
      expect(codes(diagnose({ inspection: { ...INSPECTED, pageFetchState } }))).toEqual([]);
    }
  });
});

describe('diagnose: cause', () => {
  it('is clean when only Google hints apply', () => {
    const result = diagnose({ inspection: { ...INSPECTED, pageFetchState: 'SOFT_404', googleCanonical: 'https://a.de/other' } });
    expect(result.cause).toBe('clean');
    expect(result.findings).toHaveLength(2);
  });

  it('is clean when nothing applies', () => {
    expect(diagnose()).toEqual({ cause: 'clean', findings: [] });
  });

  it('is unknown when the inspection entry is missing or unknown, even with a clean fetch', () => {
    expect(diagnose({ inspection: undefined }).cause).toBe('unknown');
    expect(diagnose({ inspection: { ...INSPECTED, coverageState: 'unknown' } }).cause).toBe('unknown');
  });

  it('is technical when a technical finding sits next to an unknown one', () => {
    const result = diagnose({ response: ok({ headers: { 'x-robots-tag': 'noindex' } }), inspection: undefined });
    expect(result.cause).toBe('technical');
  });

  it('carries a fix text per finding', () => {
    expect(diagnose({ response: ok({ status: 404 }) }).findings[0].fix).toMatch(/404/);
  });
});
