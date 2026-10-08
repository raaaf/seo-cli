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
