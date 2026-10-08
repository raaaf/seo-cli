import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const api = { getUserSites: vi.fn(), getQueryStats: vi.fn() };
vi.mock('../src/lib/bing.js', async (orig) => ({ ...(await orig()), getUserSites: (...a) => api.getUserSites(...a), getQueryStats: (...a) => api.getQueryStats(...a) }));
vi.mock('../src/lib/gsc.js', () => ({ queryPageTotals: async () => [], getAuth: vi.fn(), rethrowWithAuthHint: (e) => { throw e; } }));
const nextIndex = { entries: [] };
vi.mock('../src/lib/indexnow.js', () => ({ fetchSitemapUrls: async () => nextIndex.entries.map(e => e.url) }));
vi.mock('../src/lib/index-status.js', async (orig) => ({ ...(await orig()), fetchIndexStatus: async () => nextIndex.entries }));

const { aggregateQueries, bingCandidates, refreshBingQueries } = await import('../src/lib/signals/bing.js');
const { putSignal } = await import('../src/lib/signals/store.js');
const { evaluateWatch } = await import('../src/lib/watch.js');
const { watch } = await import('../src/steps/watch.js');
const { diagnoseAlerts } = await import('../src/steps/diagnose.js');
const { normalizeUrl } = await import('../src/lib/bing.js');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-bing-fix-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.BING_WEBMASTER_KEY; });

describe('evaluateWatch: Bing switched off', () => {
  const alert = (id) => ({ id, kind: id, since: '2026-10-01', detail: 'x' });
  const state = (ids) => ({ open: ids.map(alert), known_indexed: [] });
  const eval1 = (ids, bing) => evaluateWatch(state([...ids, 'other']), { today: '2026-10-08', entries: null, traffic: null, bing });

  it('closes the three Bing alerts with reason bing_disabled and leaves others', () => {
    const { state: next, resolved } = eval1(['bing_blind', 'bing_crawl_issues', 'bing_site_not_crawled'], { disabled: true });
    expect(resolved.map(a => a.reason)).toEqual(['bing_disabled', 'bing_disabled', 'bing_disabled']);
    expect(next.open.map(a => a.id)).toContain('other');
    expect(next.bing).toBeUndefined();
  });

  it('keeps them when the site is missing in Bing (bing null)', () => {
    const { resolved } = eval1(['bing_blind'], null);
    expect(resolved).toEqual([]);
  });
});

describe('bing signals', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  const row = (over) => ({ Query: 'q', Impressions: 10, Clicks: 0, AvgImpressionPosition: 10, Date: `/Date(${now.getTime() - 86400000})/`, ...over });

  it('drops rows without a numeric position instead of counting them as position 0', () => {
    const out = aggregateQueries([row({ AvgImpressionPosition: undefined }), row({ Impressions: 10, AvgImpressionPosition: 12 })], { now });
    expect(out).toEqual([{ query: 'q', impressions: 10, clicks: 0, position: 12 }]);
  });

  it('uses the GSC window 8 to 25 for start-mode candidates', () => {
    const q = (position) => ({ query: `k${position}`, impressions: 9, clicks: 0, position });
    expect(bingCandidates([q(3), q(8), q(25), q(26)], {}).map(c => c.keyword).sort()).toEqual(['k25', 'k8']);
  });

  it('treats a stored empty query list as fresh: no refetch inside the TTL', async () => {
    const config = { base_url: 'https://x.de', bing: { enabled: true } };
    process.env.BING_WEBMASTER_KEY = 'k';
    api.getUserSites.mockReset().mockResolvedValue([{ Url: 'https://x.de/' }]);
    api.getQueryStats.mockReset().mockResolvedValue([]);
    putSignal('bing', 'queries:https://x.de/', [], new Date(), { cwd: dir, ttlDays: 7 });
    await refreshBingQueries({ config, cwd: dir, warnings: [], now: new Date() });
    expect(api.getQueryStats).not.toHaveBeenCalled();
  });
});

describe('url normalisation', () => {
  it('drops trailing slashes and case', () => expect(normalizeUrl('https://A.de/x//')).toBe('https://a.de/x'));
});

describe('watch step: Bing per-URL failures', () => {
  const CONFIG = { gsc_property: 'sc-domain:a.de', base_url: 'https://a.de', locales: ['de'], landing_path: 'content/de/', bing: { enabled: true } };
  const url = (s) => `https://a.de/${s}`;
  const entry = (s) => ({ url: url(s), coverageState: 'Submitted and indexed', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null });
  const err = (kind) => Object.assign(new Error('x'), { kind });
  const bingApi = (getUrlInfo, issues = []) => ({
    getUserSites: async () => [{ Url: 'https://a.de/' }], getCrawlIssues: async () => issues, getUrlInfo, isCrawled: (i) => i.ok,
  });
  const go = (today, api) => watch({ config: CONFIG, cwd: dir, today, diagnose: async () => ({ updated: [] }), submit: async () => {}, bingApi: api });
  const alerts = () => JSON.parse(readFileSync(join(dir, 'seo/alerts.json'), 'utf8'));

  beforeEach(() => {
    process.env.BING_WEBMASTER_KEY = 'k';
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    nextIndex.entries = [entry('a'), entry('b')];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('keeps the previous value of a failing URL and still evaluates crawl issues', async () => {
    await go('2026-10-07', bingApi(async () => ({ ok: true })));
    expect(alerts().bing.crawled).toEqual({ [url('a')]: true, [url('b')]: true });
    const getUrlInfo = async (_s, u) => { if (u === url('a')) throw err('unavailable'); return { ok: false }; };
    const issues = [{ Url: url('b') }];
    await go('2026-10-08', bingApi(getUrlInfo, issues));
    const bing = alerts().bing;
    expect(bing.crawled).toEqual({ [url('a')]: true, [url('b')]: false });
    expect(bing.issues_pending).toBeDefined();
    expect(bing.last_ok).toBe('2026-10-08');
  });

  it('is an error only when every call fails', async () => {
    const report = await go('2026-10-08', bingApi(async () => { throw err('unavailable'); }));
    expect(report.warnings.join()).toMatch(/Bing check failed/);
    expect(alerts().bing.crawled).toBeUndefined();
    expect(alerts().bing.last_ok).toBe('2026-10-08');
    expect(alerts().bing.issues_pending).toBeUndefined();
  });
});

describe('diagnose: reuses the watcher values', () => {
  it('calls getUrlInfo only for URLs without a crawled value', async () => {
    const CFG = { base_url: 'https://a.de', locales: ['de'] };
    const u = (s) => `https://a.de/${s}`;
    const e = (s) => ({ url: u(s), coverageState: 'Crawled - currently not indexed', robotsTxtState: 'ALLOWED', googleCanonical: null, pageFetchState: 'SUCCESSFUL' });
    const alerts = ['a', 'b'].map(s => ({ id: `deindexed:${u(s)}`, kind: 'deindexed', since: '2026-10-01', detail: u(s) }));
    const getUrlInfo = vi.fn(async () => ({ ok: false }));
    const bing = { site: 'https://a.de/', getUrlInfo, isCrawled: (i) => i.ok, crawled: { [u('a')]: true } };
    const fetch = async (url) => ({ status: 200, finalUrl: url, headers: {}, html: `<html><body>${'word '.repeat(80)}</body></html>` });
    await diagnoseAlerts({ alerts, entries: [e('a'), e('b')], config: CFG, today: '2026-10-08', fetch, bing });
    expect(alerts[0].diagnosis.urls[0].bing).toEqual({ crawled: true });
    expect(alerts[1].diagnosis.urls[0].bing).toEqual({ crawled: false });
    expect(getUrlInfo).toHaveBeenCalledTimes(1);
  });
});
