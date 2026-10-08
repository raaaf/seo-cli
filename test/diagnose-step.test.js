import { describe, it, expect, vi } from 'vitest';
import { diagnoseAlerts } from '../src/steps/diagnose.js';

const CONFIG = { base_url: 'https://a.de', locales: ['de'] };
const GONE = 'Crawled - currently not indexed';
const url = (slug) => `https://a.de/${slug}`;
const entry = (slug, coverageState = GONE) => ({ url: url(slug), coverageState, robotsTxtState: 'ALLOWED', googleCanonical: null, pageFetchState: 'SUCCESSFUL' });
const deindexed = (slug, extra = {}) => ({ id: `deindexed:${url(slug)}`, kind: 'deindexed', since: '2026-10-01', detail: url(slug), ...extra });
const WORDS = 'word '.repeat(80);
const clean = async (u) => ({ status: 200, finalUrl: u, headers: {}, html: `<html><body>${WORDS}</body></html>` });
const noindex = async (u) => ({ status: 200, finalUrl: u, headers: { 'x-robots-tag': 'noindex' }, html: `<html><body>${WORDS}</body></html>` });
const run = (alerts, entries, fetch, today = '2026-10-08') => diagnoseAlerts({ alerts, entries, config: CONFIG, today, fetch });

describe('diagnose-step', () => {
  it('writes the first diagnosis at once, with cause, sorted codes and per-URL findings', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], noindex);

    expect(alert.diagnosis).toMatchObject({ checked_at: '2026-10-08', cause: 'technical', codes: ['noindex_header'] });
    expect(alert.diagnosis.urls).toEqual([expect.objectContaining({ url: url('page'), cause: 'technical' })]);
  });

  it('reports the first diagnosis of an alert open from an earlier run as updated', async () => {
    const alert = deindexed('page');
    const { updated } = await run([alert], [entry('page')], clean);
    expect(updated).toEqual([alert]);
  });

  it('diagnoses a site_not_indexed alert over the not indexed URLs, base_url first', async () => {
    const alert = { id: 'site_not_indexed', kind: 'site_not_indexed', since: '2026-10-01', detail: { indexed: 0, total: 3 } };
    await run([alert], [entry('a'), entry('b', 'Submitted and indexed'), { ...entry(''), url: 'https://a.de/' }], clean);

    expect(alert.diagnosis.urls.map(u => u.url)).toEqual(['https://a.de/', url('a')]);
  });

  it('does not let one big site_not_indexed alert starve a deindexed alert', async () => {
    const site = { id: 'site_not_indexed', kind: 'site_not_indexed', since: '2026-10-01', detail: { indexed: 0, total: 12 } };
    const late = deindexed('late');
    const slugs = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const fetch = vi.fn(clean);

    await run([site, late], [...slugs.map(s => entry(s)), entry('late')], fetch);

    expect(fetch.mock.calls.map(c => c[0])).toContain(url('late'));
    expect(late.diagnosis).toBeDefined();
    expect(fetch.mock.calls.length).toBe(11); // robots.txt + 10 URLs
  });

  it('carries the fetch error message into the finding', async () => {
    const dns = deindexed('dns');
    const loop = deindexed('loop');
    const fetch = async (u) => {
      if (u.endsWith('/robots.txt')) return { status: 200 };
      throw new Error(u.endsWith('/dns') ? 'getaddrinfo ENOTFOUND a.de' : 'Too many redirects (max 5) from x');
    };

    await run([dns, loop], [entry('dns'), entry('loop')], fetch);

    expect(dns.diagnosis.urls[0].findings[0]).toMatchObject({ code: 'fetch_failed', detail: 'getaddrinfo ENOTFOUND a.de' });
    expect(dns.diagnosis.cause).toBe('unknown');
    expect(loop.diagnosis.urls[0].findings[0].code).toBe('redirect');
    expect(loop.diagnosis.cause).toBe('technical');
  });

  it('writes nothing on a later run with the same result', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], noindex, '2026-10-08');
    const snapshot = structuredClone(alert);

    const { updated } = await run([alert], [entry('page')], noindex, '2026-10-09');
    expect(alert).toEqual(snapshot);
    expect(updated).toEqual([]);
  });

  it('keeps the old diagnosis when the new result is unknown', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], clean);
    const snapshot = structuredClone(alert);

    await run([alert], [entry('page')], async () => { throw new Error('timeout'); }, '2026-10-09');
    expect(alert).toEqual(snapshot);
  });

  it('takes a changed result only on the second run in a row, then reports the alert as updated', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], clean, '2026-10-08');

    const first = await run([alert], [entry('page')], noindex, '2026-10-09');
    expect(first.updated).toEqual([]);
    expect(alert.diagnosis.cause).toBe('clean');
    expect(alert.pending_codes).toMatchObject({ cause: 'technical', codes: ['noindex_header'], date: '2026-10-09' });

    const second = await run([alert], [entry('page')], noindex, '2026-10-10');
    expect(second.updated).toEqual([alert]);
    expect(alert.diagnosis).toMatchObject({ checked_at: '2026-10-10', cause: 'technical' });
    expect(alert.pending_codes).toBeUndefined();
  });

  it('drops a pending result that does not repeat', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], clean, '2026-10-08');
    await run([alert], [entry('page')], noindex, '2026-10-09');

    const { updated } = await run([alert], [entry('page')], clean, '2026-10-10');
    expect(updated).toEqual([]);
    expect(alert.pending_codes).toBeUndefined();
    expect(alert.diagnosis.checked_at).toBe('2026-10-08');
  });

  it('merges into the existing alert and keeps assessment and resubmitted_at', async () => {
    const assessment = { assessed_at: '2026-10-01', likely_causes: [], actions: [] };
    const alert = deindexed('page', { assessment, resubmitted_at: '2026-10-05' });
    await run([alert], [entry('page')], noindex);

    expect(alert).toMatchObject({ assessment, resubmitted_at: '2026-10-05', diagnosis: { cause: 'technical' } });
  });

  it('fetches a URL shared by several alerts once, caps at 10 URLs and marks the alert sampled', async () => {
    const fetched = [];
    const fetch = async (u) => { fetched.push(u); return clean(u); };
    const slugs = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const site = { id: 'site_not_indexed', kind: 'site_not_indexed', since: '2026-10-01', detail: {} };
    const single = deindexed('p0');

    await run([single, site], slugs.map(s => entry(s)), fetch);

    const pages = fetched.filter(u => !u.endsWith('/robots.txt'));
    expect(pages).toHaveLength(10);
    expect(new Set(pages).size).toBe(10);
    expect(fetched.filter(u => u.endsWith('/robots.txt'))).toHaveLength(1);
    expect(site.diagnosis.sampled).toBe(true);
    expect(single.diagnosis.sampled).toBeUndefined();
  });

  it('treats a missing inspection entry as unknown and ignores other alert kinds', async () => {
    const alert = deindexed('page');
    const traffic = { id: 'traffic_drop', kind: 'traffic_drop', since: '2026-10-01', detail: 'x' };
    const fetch = vi.fn(clean);
    await run([alert, traffic], [], fetch);

    expect(alert.diagnosis.cause).toBe('unknown');
    expect(traffic.diagnosis).toBeUndefined();
  });

  it('reads a robots.txt 5xx into every URL', async () => {
    const alert = deindexed('page');
    await run([alert], [entry('page')], async (u) => (u.endsWith('/robots.txt') ? { status: 503, finalUrl: u, headers: {}, html: '' } : clean(u)));
    expect(alert.diagnosis.codes).toEqual(['robots_unreachable']);
  });
});
