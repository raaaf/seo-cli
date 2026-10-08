import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const queryPageTotals = vi.fn();
vi.mock('../src/lib/gsc.js', () => ({
  queryPageTotals: (...a) => queryPageTotals(...a),
  getAuth: vi.fn(),
  rethrowWithAuthHint: (e) => { throw e; },
}));
// The Inspection API call and the sitemap are the I/O boundary; the snapshot goes through the real check and save.
const nextIndex = { entries: [], error: null };
vi.mock('../src/lib/indexnow.js', () => ({ fetchSitemapUrls: async () => nextIndex.entries.map(e => e.url) }));
vi.mock('../src/lib/index-status.js', async (orig) => ({
  ...(await orig()),
  fetchIndexStatus: async () => {
    if (nextIndex.error) throw nextIndex.error;
    return nextIndex.entries;
  },
}));

const { watch } = await import('../src/steps/watch.js');
const { loadIndexStatus } = await import('../src/lib/index-status.js');
const { trafficWindows } = await import('../src/lib/watch.js');
const { diagnoseAlerts } = await import('../src/steps/diagnose.js');

const CONFIG = { gsc_property: 'sc-domain:a.de', base_url: 'https://a.de', locales: ['de'], landing_path: 'content/de/' };
const url = (slug) => `https://a.de/${slug}`;
const entry = (slug, coverageState) => ({ url: url(slug), coverageState, lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null });
const OK = 'Submitted and indexed';
const GONE = 'Crawled - currently not indexed';

let dir;
const alertsFile = () => JSON.parse(readFileSync(join(dir, 'seo/alerts.json'), 'utf8'));
let todayRef;
// Diagnosis and resubmit are network boundaries: stubbed unless a test passes its own.
const go = (today, extra = {}) => {
  todayRef = today;
  return watch({ config: CONFIG, cwd: dir, today, diagnose: async () => ({ updated: [] }), submit: async () => {}, ...extra });
};
// GSC answers by window: the current week of `today` against the week before.
function gsc({ current = 1000, previous = 1000 } = {}) {
  queryPageTotals.mockImplementation(async (_p, { endDate }) => [
    { url: url('page'), impressions: endDate === trafficWindows(todayRef).current.endDate ? current : previous, clicks: 0, position: 5 },
    { url: url('blog/other'), impressions: 99999, clicks: 0, position: 5 },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-watch-'));
  mkdirSync(join(dir, 'content/de'), { recursive: true });
  writeFileSync(join(dir, 'content/de/page.md'), '---\n---\n');
  queryPageTotals.mockReset();
  nextIndex.entries = [entry('page', OK)];
  nextIndex.error = null;
  gsc();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('watch-step', () => {
  it('opens a deindex alert once and does not repeat it the next day', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];

    const first = await go('2026-10-08');
    expect(first.status).toBe('alert');
    expect(first.alerts.opened.map(a => a.id)).toEqual([`deindexed:${url('page')}`]);

    const second = await go('2026-10-09');
    expect(second.status).toBe('watch_ok');
    expect(second.alerts).toMatchObject({ opened: [], updated: [], resolved: [] });
  });

  it('lists a site that is not indexed at all in alerts.opened on the first run', async () => {
    nextIndex.entries = ['a', 'b', 'c', 'd', 'e'].map(slug => entry(slug, GONE));

    const report = await go('2026-10-07');
    expect(report.status).toBe('alert');
    expect(report.alerts.opened.map(a => a.id)).toEqual(['site_not_indexed']);
  });

  it('reports resolved when the page is indexed again', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];
    await go('2026-10-08');
    nextIndex.entries = [entry('page', OK)];

    const report = await go('2026-10-09');
    expect(report.status).toBe('resolved');
    expect(alertsFile().open).toEqual([]);
  });

  it('opens a traffic alert on the second day of a drop over 40 percent, counting only landing pages', async () => {
    gsc({ current: 500, previous: 1000 });
    expect((await go('2026-10-07')).status).toBe('watch_ok');
    const report = await go('2026-10-08');
    expect(report.status).toBe('alert');
    expect(report.alerts.opened.map(a => a.id)).toEqual(['traffic_drop']);
    expect(report.alerts.opened[0].detail).toMatch(/50 percent/);
  });

  it('leaves overlay pages out of the landing page totals', async () => {
    queryPageTotals.mockImplementation(async (_p, { endDate }) => [
      { url: url('page'), impressions: 1000, clicks: 0, position: 5 },
      { url: url('shop/nachteule'), impressions: endDate === trafficWindows(todayRef).current.endDate ? 0 : 5000, clicks: 0, position: 5 },
    ]);
    todayRef = '2026-10-07';
    const report = await watch({ config: { ...CONFIG, overlays: { products: 'content/seo/products' } }, cwd: dir, today: '2026-10-07', diagnose: async () => ({ updated: [] }), submit: async () => {} });
    expect(report.traffic).toMatchObject({ status: 'ok', drop: 0 });
  });

  it('raises no traffic alert below the volume floor', async () => {
    gsc({ current: 0, previous: 100 });
    await go('2026-10-07');
    const report = await go('2026-10-08');
    expect(report.status).toBe('watch_ok');
    expect(report.traffic.status).toBe('insufficient');
  });

  it('turns a GSC error into a warning without an alert, and keeps the alert state', async () => {
    queryPageTotals.mockRejectedValue(new Error('GSC 500'));
    const report = await go('2026-10-07');

    expect(report.status).toBe('failed');
    expect(report.errors).toEqual(['Traffic check failed: GSC 500']);
    expect(alertsFile()).toMatchObject({ open: [], failures: 1 });
  });

  it('writes nothing on a dry run, and leaves an unchanged alerts file untouched', async () => {
    await go('2026-10-07', { dryRun: true });
    expect(existsSync(join(dir, 'seo/alerts.json'))).toBe(false);
    expect(existsSync(join(dir, 'seo/index-status.json'))).toBe(false);

    await go('2026-10-07');
    const before = readFileSync(join(dir, 'seo/alerts.json'), 'utf8');
    await go('2026-10-08');
    expect(readFileSync(join(dir, 'seo/alerts.json'), 'utf8')).toBe(before);
  });

  it('keeps the previous index entry when the inspection quota ran out', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', 'unknown')];
    const report = await go('2026-10-08');

    expect(report.status).toBe('watch_ok');
    expect(loadIndexStatus(dir).entries[0].coverageState).toBe(OK);
  });

  it('reports a failed index check as failed with the error, and opens watch_blind on the second one', async () => {
    nextIndex.error = new Error('invalid_grant: token expired');

    const first = await go('2026-10-07');
    expect(first.status).toBe('failed');
    expect(first.errors).toEqual(['Index check failed: invalid_grant: token expired']);
    expect(alertsFile()).toMatchObject({ failures: 1, open: [] });

    const second = await go('2026-10-08');
    expect(second.status).toBe('failed');
    expect(second.alerts.opened.map(a => a.id)).toEqual(['watch_blind']);
    expect(alertsFile().open.map(a => a.id)).toEqual(['watch_blind']);
  });

  it('judges the fresh snapshot on a dry run without saving it', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];

    const report = await go('2026-10-08', { dryRun: true });
    expect(report.alerts.opened.map(a => a.id)).toEqual([`deindexed:${url('page')}`]);
    expect(loadIndexStatus(dir).entries[0].coverageState).toBe(OK);
  });
});

describe('watch-step: diagnosis and resubmit', () => {
  const cleanFetch = async (u) => ({ status: 200, finalUrl: u, headers: {}, html: `<html><body>${'word '.repeat(80)}</body></html>` });
  const realDiagnose = (args) => diagnoseAlerts({ ...args, fetch: cleanFetch });
  const dropPage = async (opts = {}) => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];
    return go('2026-10-08', { diagnose: realDiagnose, ...opts });
  };

  it('stores the diagnosis on the alert and resubmits once when the live fetch is clean', async () => {
    const submit = vi.fn().mockResolvedValue();
    await dropPage({ submit });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].urls).toEqual([url('page')]);
    expect(alertsFile().open[0]).toMatchObject({ diagnosis: { cause: 'clean' }, resubmitted_at: '2026-10-08' });
    expect(alertsFile().last_resubmit).toBe('2026-10-08');
  });

  it('does not resubmit again the next day, and leaves alerts.json untouched', async () => {
    const submit = vi.fn().mockResolvedValue();
    await dropPage({ submit });
    const before = readFileSync(join(dir, 'seo/alerts.json'), 'utf8');

    await go('2026-10-09', { diagnose: realDiagnose, submit });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'seo/alerts.json'), 'utf8')).toBe(before);
  });

  it('resubmits again after a technical cause was fixed, but not before 7 days since the last submit', async () => {
    const submit = vi.fn().mockResolvedValue();
    const causing = (cause) => async ({ alerts }) => {
      for (const a of alerts) a.diagnosis = { cause, urls: [{ url: url('page') }] };
      return { updated: [] };
    };
    await dropPage({ submit, diagnose: causing('clean') });
    await go('2026-10-09', { diagnose: causing('technical'), submit });
    expect(alertsFile().open[0].resubmitted_at).toBeUndefined();
    await go('2026-10-10', { diagnose: causing('clean'), submit });
    expect(submit).toHaveBeenCalledTimes(1);
    await go('2026-10-15', { diagnose: causing('clean'), submit });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('resubmits a later clean alert only once 7 days have passed since the last submit', async () => {
    const submit = vi.fn().mockResolvedValue();
    await dropPage({ submit });
    nextIndex.entries = [entry('page', GONE), entry('other', OK)];
    await go('2026-10-09', { diagnose: realDiagnose, submit });
    nextIndex.entries = [entry('page', GONE), entry('other', GONE)];

    await go('2026-10-10', { diagnose: realDiagnose, submit });
    expect(submit).toHaveBeenCalledTimes(1);
    await go('2026-10-14', { diagnose: realDiagnose, submit });
    expect(submit).toHaveBeenCalledTimes(1);
    await go('2026-10-15', { diagnose: realDiagnose, submit });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('sets nothing when the submit fails, and reports a warning instead of a failure', async () => {
    const report = await dropPage({ submit: async () => { throw new Error('403 forbidden'); } });

    expect(report.status).toBe('alert');
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(['Resubmit failed: 403 forbidden']);
    expect(alertsFile().open[0].resubmitted_at).toBeUndefined();
    expect(alertsFile().last_resubmit).toBeUndefined();
  });

  it('turns a diagnosis error into a warning and still keeps the alert', async () => {
    const report = await dropPage({ diagnose: async () => { throw new Error('boom'); } });

    expect(report.status).toBe('alert');
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(['Diagnosis failed: boom']);
    expect(alertsFile().open.map(a => a.id)).toEqual([`deindexed:${url('page')}`]);
  });

  it('does not diagnose when the index check failed', async () => {
    const diagnose = vi.fn();
    nextIndex.error = new Error('invalid_grant');
    await go('2026-10-07', { diagnose });
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('does not resubmit on a dry run', async () => {
    const submit = vi.fn();
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];
    await go('2026-10-08', { diagnose: realDiagnose, submit, dryRun: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it('reports an already open alert with a changed diagnosis as updated, status alert', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];
    await go('2026-10-08');
    const diagnose = async ({ alerts }) => ({ updated: alerts });

    const report = await go('2026-10-09', { diagnose });
    expect(report.status).toBe('alert');
    expect(report.alerts.updated.map(a => a.id)).toEqual([`deindexed:${url('page')}`]);
    expect(report.alerts.opened).toEqual([]);
  });

  it('reports an alert open from an earlier run without diagnosis as updated once diagnosed, a new one not', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];
    await go('2026-10-08');
    expect(alertsFile().open[0].diagnosis).toBeUndefined();
    nextIndex.entries = [entry('page', GONE), entry('other', OK)];
    await go('2026-10-09');
    nextIndex.entries = [entry('page', GONE), entry('other', GONE)];

    const report = await go('2026-10-10', { diagnose: realDiagnose });

    expect(report.status).toBe('alert');
    expect(report.alerts.opened.map(a => a.detail)).toEqual([url('other')]);
    expect(report.alerts.updated.map(a => a.detail)).toEqual([url('page')]);
  });

  it('lists an alert opened in this run only under opened, even if its diagnosis counts as updated', async () => {
    await go('2026-10-07');
    nextIndex.entries = [entry('page', GONE)];

    const report = await go('2026-10-08', { diagnose: async ({ alerts }) => ({ updated: alerts }) });
    expect(report.alerts.opened).toHaveLength(1);
    expect(report.alerts.updated).toEqual([]);
  });
});

describe('watch-step: deploy checks', () => {
  const NEW_PR = { number: 1, headRef: 'seo/new/neu', mergedAt: '2026-10-01T09:00:00Z', files: ['content/de/neu.md'] };
  const OVERLAY_PR = { number: 2, headRef: 'seo/improve/product-nachteule', mergedAt: '2026-10-01T09:00:00Z', files: ['content/seo/products/nachteule.md'] };
  const ON = { ...CONFIG, repo: 'o/r', watch: { check_deploy: true }, overlays: { products: 'content/seo/products' } };
  const seedOverlay = (title) => {
    mkdirSync(join(dir, 'content/seo/products'), { recursive: true });
    writeFileSync(join(dir, 'content/seo/products/nachteule.md'), `---\nmeta_title: ${title}\n---\n`);
  };
  // Day of October 2026 at noon UTC, as the watcher's clock.
  const at = (day) => Date.parse(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);
  // The GitHub call is the only mock besides the page fetch.
  const prs = (...list) => vi.fn(async () => list);
  // fetchPage answers by URL: { status, html }.
  const pages = (answers) => async (u, { method }) => {
    const a = answers[u];
    if (a instanceof Error) throw a;
    return { status: a.status, html: method === 'GET' ? (a.html ?? '') : '' };
  };
  const check = (day, extra) => go(`2026-10-${String(day).padStart(2, '0')}`, { config: ON, now: at(day), ...extra });

  it('does nothing without watch.check_deploy', async () => {
    const listPRs = vi.fn();
    await go('2026-10-08', { listPRs });
    expect(listPRs).not.toHaveBeenCalled();
  });

  it('asks GitHub for seo PRs of the configured repo from 14 days back', async () => {
    const listPRs = prs();
    await check(8, { listPRs, fetchPage: pages({}) });
    expect(listPRs).toHaveBeenCalledWith('o/r', new Date(at(8) - 14 * 86400000).toISOString());
  });

  it('opens not_deployed for a merged page that is 404 on two days in a row, and not before', async () => {
    const extra = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 404 } }) };
    expect((await check(8, extra)).alerts.opened).toEqual([]);
    const second = await check(9, extra);
    expect(second.status).toBe('alert');
    expect(second.alerts.opened.map(a => a.id)).toEqual(['not_deployed:neu']);
  });

  it('resolves the alert once the page answers', async () => {
    const down = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 404 } }) };
    await check(8, down);
    await check(9, down);
    const report = await check(10, { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 200 } }) });
    expect(report.status).toBe('resolved');
    expect(alertsFile().open).toEqual([]);
  });

  it('keeps checking an open alert by its stored URL after its PR left the window', async () => {
    writeFileSync(join(dir, 'content/de/neu.md'), '---\n---\n');
    const down = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 404 } }) };
    await check(8, down);
    await check(9, down);
    const stillDown = await check(10, { listPRs: prs(), fetchPage: pages({ [url('neu')]: { status: 404 } }) });
    expect(stillDown.alerts.resolved).toEqual([]);
    expect(alertsFile().open.map(a => a.id)).toEqual(['not_deployed:neu']);
    const up = await check(11, { listPRs: prs(), fetchPage: pages({ [url('neu')]: { status: 200 } }) });
    expect(up.status).toBe('resolved');
  });

  it('resolves an open alert as removed once its file is gone', async () => {
    writeFileSync(join(dir, 'content/de/neu.md'), '---\n---\n');
    const down = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 404 } }) };
    await check(8, down);
    await check(9, down);
    rmSync(join(dir, 'content/de/neu.md'));
    const report = await check(10, { listPRs: prs(), fetchPage: pages({}) });
    expect(report.alerts.resolved).toMatchObject([{ id: 'not_deployed:neu', reason: 'removed' }]);
  });

  it('skips a PR merged less than 24 hours ago', async () => {
    const fresh = { ...NEW_PR, mergedAt: new Date(at(8) - 23 * 3600000).toISOString() };
    const old = { ...NEW_PR, files: ['content/de/alt.md'], mergedAt: new Date(at(8) - 25 * 3600000).toISOString() };
    const fetchPage = vi.fn(async () => ({ status: 200, html: '' }));
    await check(8, { listPRs: prs(fresh, old), fetchPage });
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([url('alt')]);
  });

  it('maps a landing file to its page URL and an overlay file to its overlay URL, and ignores other files', async () => {
    seedOverlay('titel');
    const other = { ...NEW_PR, number: 3, files: ['README.md', 'content/de/sub/x.md', 'content/en/neu-en.md'] };
    const rewrite = { ...NEW_PR, number: 4, headRef: 'seo/improve/preise', files: ['content/de/preise.md'] };
    const fetchPage = vi.fn(async () => ({ status: 200, html: '<title>titel</title>' }));
    await check(8, { listPRs: prs(NEW_PR, OVERLAY_PR, other, rewrite), fetchPage });
    expect(fetchPage.mock.calls.map(c => [c[0], c[1].method])).toEqual([
      [url('neu'), 'HEAD'],
      ['https://a.de/shop/nachteule', 'GET'],
    ]);
  });

  it('counts a server error as undecided, not as not deployed', async () => {
    const extra = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 503 } }) };
    await check(8, extra);
    expect((await check(9, extra)).alerts.opened).toEqual([]);
  });

  it('turns a failing fetch into a warning', async () => {
    const report = await check(8, { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: new Error('timeout') }) });
    expect(report.warnings).toContain(`Deploy check of ${url('neu')} failed: timeout`);
    expect(report.errors).toEqual([]);
  });

  it('turns a GitHub error into a warning and leaves open alerts as they are', async () => {
    const down = { listPRs: prs(NEW_PR), fetchPage: pages({ [url('neu')]: { status: 404 } }) };
    await check(8, down);
    await check(9, down);
    const report = await check(10, { listPRs: vi.fn(async () => { throw new Error('GitHub 502'); }), fetchPage: pages({}) });
    expect(report.warnings).toContain('Deploy check failed: GitHub 502');
    expect(report.status).toBe('watch_ok');
    expect(alertsFile().open.map(a => a.id)).toEqual(['not_deployed:neu']);
  });

  it('compares an overlay with the live title, entities decoded and the brand suffix ignored', async () => {
    seedOverlay('"nachteule" & shirt');
    const extra = { listPRs: prs(OVERLAY_PR), fetchPage: pages({ 'https://a.de/shop/nachteule': { status: 200, html: '<title>&quot;nachteule&quot; &amp; shirt . punkt und pause</title>' } }) };
    await check(8, extra);
    expect((await check(9, extra)).alerts.opened).toEqual([]);
  });

  it('opens not_deployed for an overlay whose live title still has the old text', async () => {
    seedOverlay('neuer titel');
    const extra = { listPRs: prs(OVERLAY_PR), fetchPage: pages({ 'https://a.de/shop/nachteule': { status: 200, html: '<title>alter titel . punkt und pause</title>' } }) };
    await check(8, extra);
    const report = await check(9, extra);
    expect(report.alerts.opened.map(a => a.id)).toEqual(['not_deployed:product:nachteule']);
  });

  it('skips an overlay whose file is not on disk', async () => {
    const fetchPage = vi.fn();
    await check(8, { listPRs: prs(OVERLAY_PR), fetchPage });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe('watch-step: Bing', () => {
  const CFG = { ...CONFIG, bing: { enabled: true } };
  const SITE = 'https://a.de/';
  const never = '/Date(-62135596800000)/';
  const seen = '/Date(1776384000000)/';
  const api = (over = {}) => ({
    getUserSites: vi.fn(async () => [{ Url: SITE }]),
    getCrawlIssues: vi.fn(async () => []),
    getUrlInfo: vi.fn(async () => ({ LastCrawledDate: seen })),
    isCrawled: (info) => info.LastCrawledDate === seen,
    ...over,
  });
  const run = (today, bingApi, config = CFG) => go(today, { config, bingApi });
  beforeEach(() => { process.env.BING_WEBMASTER_KEY = 'k'; });
  afterEach(() => { delete process.env.BING_WEBMASTER_KEY; });

  it('makes no Bing call without bing.enabled and writes no bing state', async () => {
    const bingApi = api();
    await run('2026-10-07', bingApi, CONFIG);
    expect(bingApi.getUserSites).not.toHaveBeenCalled();
    expect(alertsFile().bing).toBeUndefined();
  });

  it('skips Bing with a warning when the key is missing', async () => {
    delete process.env.BING_WEBMASTER_KEY;
    const bingApi = api();
    const report = await run('2026-10-07', bingApi);
    expect(bingApi.getUserSites).not.toHaveBeenCalled();
    expect(report.warnings.join()).toMatch(/BING_WEBMASTER_KEY/);
  });

  it('records crawled booleans per sitemap URL and ignores crawl issues outside the sitemap', async () => {
    const bingApi = api({
      getUrlInfo: vi.fn(async () => ({ LastCrawledDate: never })),
      getCrawlIssues: vi.fn(async () => [{ Url: url('elsewhere') }]),
    });
    await run('2026-10-07', bingApi);
    await run('2026-10-08', bingApi);
    expect(alertsFile().bing.crawled).toEqual({ [url('page')]: false });
    expect(alertsFile().open).toEqual([]);
  });

  it('opens bing_crawl_issues for a sitemap URL on the second day', async () => {
    const bingApi = api({ getCrawlIssues: vi.fn(async () => [{ Url: url('page') }]) });
    await run('2026-10-07', bingApi);
    const report = await run('2026-10-08', bingApi);
    expect(report.alerts.opened.map(a => a.id)).toEqual(['bing_crawl_issues']);
  });

  it('warns once about a site Bing does not know and makes no URL calls', async () => {
    const bingApi = api({ getUserSites: vi.fn(async () => [{ Url: 'https://other.de/' }]) });
    const first = await run('2026-10-07', bingApi);
    const second = await run('2026-10-08', bingApi);
    expect(first.warnings.join()).toMatch(/does not know/);
    expect(second.warnings.join()).not.toMatch(/does not know/);
    expect(alertsFile().bing.site_missing_warned).toBe(true);
    expect(bingApi.getUrlInfo).not.toHaveBeenCalled();
    expect(first.errors).toEqual([]);
  });

  it('turns a Bing error into a warning, never into errors or watch_blind', async () => {
    const err = Object.assign(new Error('Bing GetUserSites failed (unavailable)'), { kind: 'unavailable' });
    const bingApi = api({ getUserSites: vi.fn(async () => { throw err; }) });
    const report = await run('2026-10-07', bingApi);
    expect(report.errors).toEqual([]);
    expect(report.status).toBe('watch_ok');
    expect(report.warnings.join()).toMatch(/Bing check failed/);
    expect(alertsFile().failures).toBe(0);
  });

  it('opens bing_blind at once when the key is rejected', async () => {
    const err = Object.assign(new Error('Bing GetUserSites failed (key_rejected)'), { kind: 'key_rejected' });
    const report = await run('2026-10-07', api({ getUserSites: vi.fn(async () => { throw err; }) }));
    expect(report.alerts.opened.map(a => a.id)).toEqual(['bing_blind']);
    expect(report.errors).toEqual([]);
  });

  it('checks at most 10 sitemap URLs a day (Bing throttles GetUrlInfo after 10 per host), a deterministic section that advances with the day', async () => {
    nextIndex.entries = Array.from({ length: 70 }, (_, i) => entry(`p${String(i).padStart(2, '0')}`, OK));
    const checked = async (today) => {
      const bingApi = api();
      await run(today, bingApi);
      return bingApi.getUrlInfo.mock.calls.map(c => c[1]);
    };
    const sorted = nextIndex.entries.map(e => e.url).sort();
    const dayNumber = Math.floor(Date.parse('2026-10-07T00:00:00Z') / 86400000);
    const start = (dayNumber * 10) % 70;
    const first = await checked('2026-10-07');
    expect(first).toEqual(Array.from({ length: 10 }, (_, i) => sorted[(start + i) % 70]));
    expect(await checked('2026-10-07')).toEqual(first);
    expect(await checked('2026-10-08')).not.toEqual(first);
  });

  it('hands the Bing client to the diagnosis only when the Bing check ran', async () => {
    const diagnose = vi.fn(async () => ({ updated: [] }));
    await go('2026-10-07', { config: CONFIG, bingApi: api(), diagnose });
    expect(diagnose.mock.calls[0][0].bing).toBeNull();
    await go('2026-10-08', { config: CFG, bingApi: api(), diagnose });
    expect(diagnose.mock.calls[1][0].bing).toMatchObject({ site: SITE });
    const err = Object.assign(new Error('x'), { kind: 'unavailable' });
    await go('2026-10-09', { config: CFG, bingApi: api({ getUserSites: vi.fn(async () => { throw err; }) }), diagnose });
    expect(diagnose.mock.calls[2][0].bing).toBeNull();
  });
});
