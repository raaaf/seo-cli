import { addDays } from './measure.js';
import { isIndexed } from './index-status.js';

// Pure rules of the watcher: traffic windows, thresholds, alert state. No I/O,
// the files and GSC access live in steps/watch.js.

export const ALERTS_FILE = 'seo/alerts.json';

// Landing page impressions in the comparison window below this are too thin to judge a drop.
export const MIN_IMPRESSIONS = 200;
// Hysteresis: opens after 2 consecutive days above 40 percent loss, resolves below 25 percent.
const DROP_OPEN = 0.4;
const DROP_RESOLVE = 0.25;
const OPEN_AFTER_DAYS = 2;
const BLIND_AFTER_FAILURES = 2;
// GSC data lags by about three days.
const GSC_LAG_DAYS = 3;

export function emptyAlerts() {
  return { version: 1, open: [], known_indexed: [], traffic_pending: null, failures: 0 };
}

/** The last 7 complete days (ending today-3) against the 7 days before them. */
export function trafficWindows(today) {
  const end = addDays(today, -GSC_LAG_DAYS);
  return {
    current: { startDate: addDays(end, -6), endDate: end },
    previous: { startDate: addDays(end, -13), endDate: addDays(end, -7) },
  };
}

/** Impression change between two sets of landing page rows. `insufficient` below the volume floor. */
export function trafficChange(currentRows, previousRows) {
  const sum = (rows) => rows.reduce((n, r) => n + r.impressions, 0);
  const current = sum(currentRows);
  const previous = sum(previousRows);
  if (previous < MIN_IMPRESSIONS) return { status: 'insufficient', current, previous, drop: null };
  return { status: 'ok', current, previous, drop: (previous - current) / previous };
}

const seenIndexed = (e) => e.coverageState !== 'unknown' && isIndexed(e.coverageState);

/** URLs that were seen indexed once and are not indexed now. A URL without an entry or with an unknown one is not judged. */
export function deindexedUrls(entries, knownIndexed) {
  const byUrl = new Map(entries.map(e => [e.url, e]));
  return knownIndexed.filter((url) => {
    const e = byUrl.get(url);
    return e && !isIndexed(e.coverageState);
  });
}

/**
 * Applies one watch run to the alert state. `entries` is the current index
 * snapshot, `traffic` the result of `trafficChange`; null for either means that
 * check failed, which leaves its alerts as they are and counts towards
 * `watch_blind`. Returns { state, opened, resolved }: the caller reports only those two.
 */
export function evaluateWatch(state, { today, entries, traffic }) {
  const next = { ...emptyAlerts(), ...state, open: [...(state.open ?? [])] };
  const opened = [];
  const resolved = [];
  const isOpen = (id) => next.open.some(a => a.id === id);
  const open = (id, kind, detail) => {
    if (isOpen(id)) return;
    const alert = { id, kind, since: today, detail };
    next.open.push(alert);
    opened.push(alert);
  };
  const close = (id) => {
    const alert = next.open.find(a => a.id === id);
    if (!alert) return;
    next.open = next.open.filter(a => a !== alert);
    resolved.push(alert);
  };

  if (entries) {
    next.known_indexed = [...new Set([...next.known_indexed, ...entries.filter(seenIndexed).map(e => e.url)])].sort();
    const dropped = deindexedUrls(entries, next.known_indexed);
    for (const url of dropped) open(`deindexed:${url}`, 'deindexed', url);
    for (const alert of next.open.filter(a => a.kind === 'deindexed' && !dropped.includes(a.detail))) close(alert.id);
  }

  if (traffic?.status === 'ok') {
    if (isOpen('traffic_drop')) {
      if (traffic.drop < DROP_RESOLVE) close('traffic_drop');
    } else if (traffic.drop > DROP_OPEN) {
      const pending = next.traffic_pending;
      if (pending?.date !== today) {
        next.traffic_pending = { count: pending?.date === addDays(today, -1) ? pending.count + 1 : 1, date: today };
      }
      if (next.traffic_pending.count >= OPEN_AFTER_DAYS) {
        open('traffic_drop', 'traffic_drop', `${Math.round(traffic.drop * 100)} percent fewer landing page impressions (${traffic.current} vs ${traffic.previous} in the 7 days before)`);
        next.traffic_pending = null;
      }
    } else {
      next.traffic_pending = null;
    }
  }

  if (!entries || !traffic) {
    next.failures += 1;
    if (next.failures >= BLIND_AFTER_FAILURES) open('watch_blind', 'watch_blind', `${next.failures} failed checks in a row, the watcher cannot see`);
  } else {
    next.failures = 0;
    close('watch_blind');
  }

  return { state: next, opened, resolved };
}
