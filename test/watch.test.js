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
