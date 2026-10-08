import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/gsc.js', () => ({ getAuth: vi.fn(), rethrowWithAuthHint: (e) => { throw e; } }));

const { trafficWindows, trafficChange, deindexedUrls, evaluateWatch, emptyAlerts } = await import('../src/lib/watch.js');

const IDX = (url, coverageState) => ({ url, coverageState });
const OK = 'Submitted and indexed';
const GONE = 'Crawled - currently not indexed';
const drop = (d) => ({ status: 'ok', drop: d, current: 100 * (1 - d), previous: 100 });
const run = (state, over, today = '2026-10-07') => evaluateWatch(state, { today, entries: [], traffic: { status: 'insufficient' }, ...over });

describe('watch: traffic windows', () => {
  it('compares the last 7 complete days (ending today-3) with the 7 days before', () => {
    expect(trafficWindows('2026-10-07')).toEqual({
      current: { startDate: '2026-09-28', endDate: '2026-10-04' },
      previous: { startDate: '2026-09-21', endDate: '2026-09-27' },
    });
  });

  it('reports a drop, and insufficient below 200 impressions in the comparison window', () => {
    expect(trafficChange([{ impressions: 50 }], [{ impressions: 200 }])).toMatchObject({ status: 'ok', drop: 0.75 });
    expect(trafficChange([{ impressions: 0 }], [{ impressions: 199 }])).toMatchObject({ status: 'insufficient' });
  });
});

describe('watch: deindex alert', () => {
  it('judges only URLs that were seen indexed, and never an unknown entry', () => {
    const entries = [IDX('a', GONE), IDX('b', GONE), IDX('c', 'unknown'), IDX('d', OK)];
    expect(deindexedUrls(entries, ['a', 'c', 'd'])).toEqual(['a']);
  });

  it('opens once, stays silent on the next day, resolves when the URL is indexed again', () => {
    let state = emptyAlerts();
    state = run(state, { entries: [IDX('a', OK)] }).state;

    const day1 = run(state, { entries: [IDX('a', GONE)] }, '2026-10-08');
    expect(day1.opened.map(a => a.id)).toEqual(['deindexed:a']);

    const day2 = run(day1.state, { entries: [IDX('a', GONE)] }, '2026-10-09');
    expect(day2.opened).toEqual([]);
    expect(day2.resolved).toEqual([]);
    expect(day2.state.open).toHaveLength(1);

    const day3 = run(day2.state, { entries: [IDX('a', OK)] }, '2026-10-10');
    expect(day3.resolved.map(a => a.id)).toEqual(['deindexed:a']);
    expect(day3.state.open).toEqual([]);
  });

  it('does not count an unknown entry as seen indexed', () => {
    const first = run(emptyAlerts(), { entries: [IDX('a', 'unknown')] });
    expect(first.state.known_indexed).toEqual([]);
    expect(run(first.state, { entries: [IDX('a', GONE)] }).opened).toEqual([]);
  });

  it('does not alert for a page that was never indexed', () => {
    expect(run(emptyAlerts(), { entries: [IDX('a', GONE)] }).opened).toEqual([]);
  });
});

describe('watch: site not indexed alert', () => {
  const urls = (n, indexed, state = GONE) => Array.from({ length: n }, (_, i) => IDX(`u${i}`, i < indexed ? OK : state));

  it('opens on the first snapshot of a site with no indexed URL', () => {
    const first = run(emptyAlerts(), { entries: urls(14, 0) });
    expect(first.opened).toMatchObject([{ id: 'site_not_indexed', kind: 'site_not_indexed', detail: { indexed: 0, total: 14 } }]);
  });

  it('is not considered below 5 judged URLs', () => {
    expect(run(emptyAlerts(), { entries: urls(4, 0) }).opened).toEqual([]);
  });

  it('does not reopen the next day', () => {
    const day1 = run(emptyAlerts(), { entries: urls(14, 0) });
    const day2 = run(day1.state, { entries: urls(14, 0) }, '2026-10-08');
    expect(day2.opened).toEqual([]);
    expect(day2.state.open).toHaveLength(1);
  });

  it('stays open between 20 and 50 percent and resolves from 50 percent', () => {
    const open = run(emptyAlerts(), { entries: urls(10, 0) }).state;
    const mid = run(open, { entries: urls(10, 3) }, '2026-10-08');
    expect(mid.resolved).toEqual([]);
    expect(mid.state.open).toHaveLength(1);

    const back = run(mid.state, { entries: urls(10, 6) }, '2026-10-09');
    expect(back.resolved.map(a => a.id)).toEqual(['site_not_indexed']);
    expect(back.state.open).toEqual([]);
  });

  it('stays closed between 20 and 50 percent', () => {
    expect(run(emptyAlerts(), { entries: urls(10, 3) }).opened).toEqual([]);
  });

  it('leaves unknown entries out of the count', () => {
    const entries = [...urls(4, 0), IDX('q1', 'unknown'), IDX('q2', 'unknown')];
    expect(run(emptyAlerts(), { entries }).opened).toEqual([]);
    expect(run(emptyAlerts(), { entries: [...entries, IDX('x', GONE)] }).opened).toMatchObject([{ detail: { indexed: 0, total: 5 } }]);
  });
});

describe('watch: sitemap removal', () => {
  it('prunes known_indexed to the current sitemap and resolves a deindex alert of a removed URL with its reason', () => {
    const open = run(run(emptyAlerts(), { entries: [IDX('a', OK), IDX('b', OK)] }).state, { entries: [IDX('a', GONE), IDX('b', OK)] }, '2026-10-08').state;
    const after = run(open, { entries: [IDX('b', OK)] }, '2026-10-09');

    expect(after.state.known_indexed).toEqual(['b']);
    expect(after.resolved).toMatchObject([{ id: 'deindexed:a', reason: 'removed_from_sitemap' }]);
    expect(after.state.open).toEqual([]);
  });

  it('gives no reason when the URL is indexed again', () => {
    const open = run(run(emptyAlerts(), { entries: [IDX('a', OK)] }).state, { entries: [IDX('a', GONE)] }, '2026-10-08').state;
    expect(run(open, { entries: [IDX('a', OK)] }, '2026-10-09').resolved[0].reason).toBeUndefined();
  });
});

describe('watch: traffic alert with hysteresis', () => {
  it('opens only on the second consecutive day above 40 percent', () => {
    const day1 = run(emptyAlerts(), { traffic: drop(0.5) }, '2026-10-07');
    expect(day1.opened).toEqual([]);
    const day2 = run(day1.state, { traffic: drop(0.5) }, '2026-10-08');
    expect(day2.opened.map(a => a.id)).toEqual(['traffic_drop']);
  });

  it('counts a day only once, and restarts after a gap or a good day', () => {
    const a = run(emptyAlerts(), { traffic: drop(0.5) }, '2026-10-07');
    expect(run(a.state, { traffic: drop(0.5) }, '2026-10-07').opened).toEqual([]);
    expect(run(a.state, { traffic: drop(0.5) }, '2026-10-09').opened).toEqual([]);
    const recovered = run(a.state, { traffic: drop(0.1) }, '2026-10-08');
    expect(run(recovered.state, { traffic: drop(0.5) }, '2026-10-09').opened).toEqual([]);
  });

  it('stays open between 25 and 40 percent and resolves below 25 percent', () => {
    const open = run(run(emptyAlerts(), { traffic: drop(0.5) }, '2026-10-07').state, { traffic: drop(0.5) }, '2026-10-08').state;
    expect(run(open, { traffic: drop(0.3) }, '2026-10-09').resolved).toEqual([]);
    expect(run(open, { traffic: drop(0.2) }, '2026-10-09').resolved.map(a => a.id)).toEqual(['traffic_drop']);
  });

  it('resolves against the volume it opened with, also when the week fell under the volume floor', () => {
    const open = run(run(emptyAlerts(), { traffic: drop(0.5) }, '2026-10-07').state, { traffic: drop(0.5) }, '2026-10-08').state;
    expect(open.open[0].reference).toBe(100);
    const thin = (current) => ({ status: 'insufficient', current, previous: 150, drop: null });
    expect(run(open, { traffic: thin(70) }, '2026-10-09').resolved).toEqual([]);
    expect(run(open, { traffic: thin(75) }, '2026-10-09').resolved.map(a => a.id)).toEqual(['traffic_drop']);
  });

  it('forgets a pending drop day when the next day is under the volume floor', () => {
    const day1 = run(emptyAlerts(), { traffic: drop(0.5) }, '2026-10-07');
    const thin = run(day1.state, { traffic: { status: 'insufficient', current: 0, previous: 150, drop: null } }, '2026-10-08');
    expect(thin.state.traffic_pending).toBeNull();
    expect(run(thin.state, { traffic: drop(0.5) }, '2026-10-09').opened).toEqual([]);
  });

  it('opens nothing on thin volume', () => {
    const state = { ...emptyAlerts(), traffic_pending: { count: 1, date: '2026-10-06' } };
    expect(run(state, { traffic: { status: 'insufficient', drop: null } }).opened).toEqual([]);
  });
});

describe('watch: blind counter', () => {
  it('opens watch_blind after 2 failed runs in a row and resolves on the first good one', () => {
    const f1 = run(emptyAlerts(), { entries: null });
    expect(f1.opened).toEqual([]);
    expect(f1.state.failures).toBe(1);
    const f2 = run(f1.state, { traffic: null }, '2026-10-08');
    expect(f2.opened.map(a => a.id)).toEqual(['watch_blind']);
    const ok = run(f2.state, {}, '2026-10-09');
    expect(ok.resolved.map(a => a.id)).toEqual(['watch_blind']);
    expect(ok.state.failures).toBe(0);
  });

  it('leaves the deindex alerts as they are while the index check fails', () => {
    const open = run(run(emptyAlerts(), { entries: [IDX('a', OK)] }).state, { entries: [IDX('a', GONE)] }).state;
    const failed = run(open, { entries: null }, '2026-10-08');
    expect(failed.state.open.map(a => a.id)).toEqual(['deindexed:a']);
    expect(failed.resolved).toEqual([]);
  });
});

describe('watch: not_deployed alert', () => {
  const live = (ok, key = 'page', url = 'https://a.de/page') => [{ key, url, ok }];
  const day = (state, liveChecks, today) => run(state, { liveChecks }, today);

  it('opens only on the second consecutive day a page is missing live', () => {
    const day1 = day(emptyAlerts(), live(false), '2026-10-07');
    expect(day1.opened).toEqual([]);
    expect(day1.state.deploy_pending).toEqual({ page: { count: 1, date: '2026-10-07' } });
    const day2 = day(day1.state, live(false), '2026-10-08');
    expect(day2.opened).toMatchObject([{ id: 'not_deployed:page', kind: 'not_deployed', detail: 'https://a.de/page' }]);
    expect(day2.state.deploy_pending).toBeUndefined();
  });

  it('counts a day only once and restarts after a gap or a live day', () => {
    const a = day(emptyAlerts(), live(false), '2026-10-07');
    expect(day(a.state, live(false), '2026-10-07').opened).toEqual([]);
    expect(day(a.state, live(false), '2026-10-09').opened).toEqual([]);
    const fixed = day(a.state, live(true), '2026-10-08');
    expect(fixed.state.deploy_pending).toBeUndefined();
    expect(day(fixed.state, live(false), '2026-10-09').opened).toEqual([]);
  });

  it('does not reopen an open alert and resolves it when the page is live', () => {
    const open = day(day(emptyAlerts(), live(false), '2026-10-07').state, live(false), '2026-10-08').state;
    expect(day(open, live(false), '2026-10-09').opened).toEqual([]);
    const fixed = day(open, live(true), '2026-10-09');
    expect(fixed.resolved.map(a => a.id)).toEqual(['not_deployed:page']);
    expect(fixed.state.open).toEqual([]);
  });

  it('lets an undecided check change nothing', () => {
    const pending = day(emptyAlerts(), live(false), '2026-10-07').state;
    const unknown = day(pending, live(null), '2026-10-08');
    expect(unknown.opened).toEqual([]);
    expect(unknown.state.deploy_pending).toEqual(pending.deploy_pending);
    const open = day(pending, live(false), '2026-10-08').state;
    expect(day(open, live(null), '2026-10-09').resolved).toEqual([]);
  });

  it('keeps an unlisted alert open, resolves a removed one with a reason, and drops stale pending state', () => {
    const open = day(day(emptyAlerts(), live(false), '2026-10-07').state, live(false), '2026-10-08').state;
    expect(day(open, [], '2026-10-09').resolved).toEqual([]);
    const gone = day(open, [{ key: 'page', url: 'https://a.de/page', ok: null, removed: true }], '2026-10-09');
    expect(gone.resolved).toMatchObject([{ id: 'not_deployed:page', reason: 'removed' }]);
    const pending = day(emptyAlerts(), live(false), '2026-10-07').state;
    expect(day(pending, [], '2026-10-08').state.deploy_pending).toBeUndefined();
  });

  it('keeps alerts and pending state as they are when deploy checks are off', () => {
    const open = day(day(emptyAlerts(), live(false), '2026-10-07').state, live(false), '2026-10-08').state;
    const off = day(open, null, '2026-10-09');
    expect(off.state.open.map(a => a.id)).toEqual(['not_deployed:page']);
    expect(off.resolved).toEqual([]);
  });

  it('adds no state key without deploy checks', () => {
    expect(run(emptyAlerts(), {}).state).toEqual(emptyAlerts());
  });
});

describe('watch: Bing alerts', () => {
  const urls = ['a', 'b', 'c', 'd', 'e'].map(s => `https://a.de/${s}`);
  const bing = (over = {}) => ({ urls, issues: [], crawled: Object.fromEntries(urls.map(u => [u, true])), ...over });
  const day = (state, input, today) => run(state, { bing: input }, today);
  const ids = (r) => r.state.open.map(a => a.id);

  it('opens bing_crawl_issues on the second day in a row with issues and names the first three URLs', () => {
    const issues = urls.slice(0, 4);
    const one = day(emptyAlerts(), bing({ issues }), '2026-10-07');
    expect(one.opened).toEqual([]);
    const two = day(one.state, bing({ issues }), '2026-10-08');
    expect(two.opened.map(a => a.id)).toEqual(['bing_crawl_issues']);
    expect(two.opened[0].detail).toContain('4 sitemap URL(s)');
    expect(two.opened[0].detail).toContain(`${urls[0]}, ${urls[1]}, ${urls[2]}`);
    expect(two.opened[0].detail).not.toContain(urls[3]);
  });

  it('restarts the issue count after a gap day and after a clean day', () => {
    const one = day(emptyAlerts(), bing({ issues: [urls[0]] }), '2026-10-07');
    expect(day(one.state, bing({ issues: [urls[0]] }), '2026-10-09').opened).toEqual([]);
    const clean = day(one.state, bing(), '2026-10-08');
    expect(day(clean.state, bing({ issues: [urls[0]] }), '2026-10-09').opened).toEqual([]);
  });

  it('closes bing_crawl_issues when the issues are gone', () => {
    let state = day(day(emptyAlerts(), bing({ issues: [urls[0]] }), '2026-10-07').state, bing({ issues: [urls[0]] }), '2026-10-08').state;
    const out = day(state, bing(), '2026-10-09');
    expect(out.resolved.map(a => a.id)).toEqual(['bing_crawl_issues']);
  });

  const cold = Object.fromEntries(urls.map(u => [u, false]));
  it('opens bing_site_not_crawled below 20 percent on two days in a row, needs 5 judged URLs, closes from 50 percent', () => {
    const one = day(emptyAlerts(), bing({ crawled: cold }), '2026-10-07');
    expect(one.opened).toEqual([]);
    const two = day(one.state, bing({ crawled: cold }), '2026-10-08');
    expect(two.opened).toMatchObject([{ id: 'bing_site_not_crawled', detail: { crawled: 0, total: 5 } }]);

    const mid = day(two.state, bing({ crawled: { [urls[0]]: true, [urls[1]]: true, [urls[2]]: true } }), '2026-10-09');
    expect(mid.resolved.map(a => a.id)).toEqual(['bing_site_not_crawled']);

    const few = day(emptyAlerts(), bing({ urls: urls.slice(0, 4), crawled: { [urls[0]]: false, [urls[1]]: false, [urls[2]]: false, [urls[3]]: false } }), '2026-10-07');
    expect(day(few.state, bing({ urls: urls.slice(0, 4), crawled: {} }), '2026-10-08').opened).toEqual([]);
  });

  it('keeps an open bing_site_not_crawled between 20 and 50 percent and resets the pending day above 20', () => {
    const open = day(day(emptyAlerts(), bing({ crawled: cold }), '2026-10-07').state, bing({ crawled: cold }), '2026-10-08').state;
    const half = { ...cold, [urls[0]]: true };
    expect(ids(day(open, bing({ crawled: half }), '2026-10-09'))).toContain('bing_site_not_crawled');
    const pending = day(emptyAlerts(), bing({ crawled: cold }), '2026-10-07').state;
    const warm = day(pending, bing({ crawled: half }), '2026-10-08').state;
    expect(day(warm, bing({ crawled: cold }), '2026-10-09').opened).toEqual([]);
  });

  it('prunes bing.crawled to the sitemap and keeps yesterday values for URLs not checked today', () => {
    const first = day(emptyAlerts(), bing({ crawled: { [urls[0]]: true, [urls[1]]: false } }), '2026-10-07');
    const second = day(first.state, bing({ urls: urls.slice(0, 3), crawled: { [urls[2]]: true } }), '2026-10-08');
    expect(second.state.bing.crawled).toEqual({ [urls[0]]: true, [urls[1]]: false, [urls[2]]: true });
    const third = day(second.state, bing({ urls: urls.slice(0, 2), crawled: {} }), '2026-10-09');
    expect(Object.keys(third.state.bing.crawled)).toEqual([urls[0], urls[1]]);
  });

  it('opens bing_blind at once on a rejected key and closes it on the next success', () => {
    const rejected = day(emptyAlerts(), { error: 'key_rejected' }, '2026-10-07');
    expect(rejected.opened.map(a => a.id)).toEqual(['bing_blind']);
    expect(day(rejected.state, bing(), '2026-10-08').resolved.map(a => a.id)).toEqual(['bing_blind']);
  });

  it('opens bing_blind after 3 days without a success, not before', () => {
    const ok = day(emptyAlerts(), bing(), '2026-10-07').state;
    const d2 = day(ok, { error: 'unavailable' }, '2026-10-09');
    expect(d2.opened).toEqual([]);
    expect(day(d2.state, { error: 'unavailable' }, '2026-10-10').opened.map(a => a.id)).toEqual(['bing_blind']);
    expect(day(emptyAlerts(), { error: 'unavailable' }, '2026-10-07').opened).toEqual([]);
  });

  it('leaves Bing alerts and state alone on a failed call and never counts Bing as a failed check', () => {
    const open = day(day(emptyAlerts(), bing({ issues: [urls[0]] }), '2026-10-07').state, bing({ issues: [urls[0]] }), '2026-10-08').state;
    const failed = day(open, { error: 'unavailable' }, '2026-10-09');
    expect(ids(failed)).toEqual(['bing_crawl_issues']);
    expect(failed.state.failures).toBe(0);
    expect(failed.state.bing.crawled).toEqual(open.bing.crawled);
  });

  it('with bing null changes nothing, also not the blind counter', () => {
    const open = day(day(emptyAlerts(), bing({ issues: [urls[0]] }), '2026-10-07').state, bing({ issues: [urls[0]] }), '2026-10-08').state;
    const off = day(open, null, '2026-10-09');
    expect(off.state).toEqual({ ...open, failures: 0 });
    expect(off.resolved).toEqual([]);
    expect(run(emptyAlerts(), {}).state).toEqual(emptyAlerts());
    const blind = evaluateWatch(emptyAlerts(), { today: '2026-10-07', entries: [], traffic: { status: 'insufficient' }, bing: null });
    expect(blind.state.failures).toBe(0);
  });

  it('clears the site-missing marker once Bing knows the site', () => {
    const state = { ...emptyAlerts(), bing: { site_missing_warned: true } };
    expect(day(state, bing(), '2026-10-07').state.bing.site_missing_warned).toBeUndefined();
  });
});
