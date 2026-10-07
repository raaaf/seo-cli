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

const CONFIG = { gsc_property: 'sc-domain:a.de', base_url: 'https://a.de', locales: ['de'], landing_path: 'content/de/' };
const url = (slug) => `https://a.de/${slug}`;
const entry = (slug, coverageState) => ({ url: url(slug), coverageState, lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null });
const OK = 'Submitted and indexed';
const GONE = 'Crawled - currently not indexed';

let dir;
const alertsFile = () => JSON.parse(readFileSync(join(dir, 'seo/alerts.json'), 'utf8'));
let todayRef;
const go = (today, extra = {}) => { todayRef = today; return watch({ config: CONFIG, cwd: dir, today, ...extra }); };
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
    expect(second.alerts).toEqual({ opened: [], resolved: [] });
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
