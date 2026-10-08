import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { addDays } from './measure.js';
import { isIndexed } from './index-status.js';

// Rules of the watcher: traffic windows, thresholds, alert state. Pure except
// loadAlerts/saveAlerts; GSC access lives in steps/watch.js.

export const ALERTS_FILE = 'seo/alerts.json';

// Landing page impressions in the comparison window below this are too thin to judge a drop.
export const MIN_IMPRESSIONS = 200;
// Hysteresis: opens after 2 consecutive days above 40 percent loss, resolves below 25 percent.
const DROP_OPEN = 0.4;
// An open alert resolves once the week is back at 75 percent of the volume it was measured against.
const RESOLVE_SHARE = 1 - 0.25;
const OPEN_AFTER_DAYS = 2;
const BLIND_AFTER_FAILURES = 2;
// GSC data lags by about three days.
const GSC_LAG_DAYS = 3;
// Site level: judged only with enough verdicts, opens below 20 percent indexed, resolves from 50 percent.
const SITE_MIN_URLS = 5;
const SITE_OPEN_BELOW = 0.2;
const SITE_RESOLVE_FROM = 0.5;
// A merged page that is still missing live opens `not_deployed` on the second day in a row.
const DEPLOY_OPEN_AFTER_DAYS = 2;

export function emptyAlerts() {
  return { version: 1, open: [], known_indexed: [], traffic_pending: null, failures: 0 };
}

export function loadAlerts(cwd, warnings) {
  const path = join(cwd, ALERTS_FILE);
  if (!existsSync(path)) return emptyAlerts();
  try {
    return { ...emptyAlerts(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    warnings.push(`${ALERTS_FILE} unreadable, starting from empty alerts: ${e.message}`);
    return emptyAlerts();
  }
}

// Written only when the content changes, so a quiet day leaves the file as it is.
export function saveAlerts(state, cwd) {
  const path = join(cwd, ALERTS_FILE);
  const content = JSON.stringify(state, null, 2) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

// One more consecutive day for a pending condition: counted once per day, restarts after a gap.
const bumpPending = (seen, today) => (
  seen?.date === today ? seen : { count: seen?.date === addDays(today, -1) ? seen.count + 1 : 1, date: today }
);

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

// Against the volume the alert opened with, so a week that fell under the volume floor can still resolve.
// An alert without a reference (opened before it was stored) falls back to the plain comparison.
function trafficRecovered(alert, traffic) {
  if (alert.reference) return traffic.current >= alert.reference * RESOLVE_SHARE;
  return traffic.status === 'ok' && traffic.drop < 1 - RESOLVE_SHARE;
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
 *
 * `liveChecks` is `[{ key, url, ok }]` for merged pages and overlays that should be live, or
 * null when deploy checks are off (alerts left alone). `ok: null` means the check could not
 * decide (server error, fetch failure) and changes nothing; `removed: true` (the file left the
 * repo) resolves the alert with reason `removed`. An open alert stays open until a check
 * succeeds, so the caller keeps listing it after its PR left the check window. State: `deploy_pending[key]`, present only while a check is pending.
 */
export function evaluateWatch(state, { today, entries, traffic, liveChecks = null }) {
  const next = { ...emptyAlerts(), ...state, open: [...(state.open ?? [])] };
  const opened = [];
  const resolved = [];
  const isOpen = (id) => next.open.some(a => a.id === id);
  const open = (id, kind, detail, extra = {}) => {
    if (isOpen(id)) return;
    const alert = { id, kind, since: today, detail, ...extra };
    next.open.push(alert);
    opened.push(alert);
  };
  const close = (id, reason) => {
    const alert = next.open.find(a => a.id === id);
    if (!alert) return;
    next.open = next.open.filter(a => a !== alert);
    resolved.push(reason ? { ...alert, reason } : alert);
  };

  if (entries) {
    // The entries are the current sitemap: a URL that left it is no longer ours to watch.
    const inSitemap = new Set(entries.map(e => e.url));
    next.known_indexed = [...new Set([...next.known_indexed, ...entries.filter(seenIndexed).map(e => e.url)])].filter(url => inSitemap.has(url)).sort();
    const dropped = deindexedUrls(entries, next.known_indexed);
    for (const url of dropped) open(`deindexed:${url}`, 'deindexed', url);
    for (const alert of next.open.filter(a => a.kind === 'deindexed' && !dropped.includes(a.detail))) {
      close(alert.id, inSitemap.has(alert.detail) ? undefined : 'removed_from_sitemap');
    }

    // Independent of known_indexed: a site that was never indexed has nothing to lose per URL.
    const judged = entries.filter(e => e.coverageState !== 'unknown');
    if (judged.length >= SITE_MIN_URLS) {
      const indexed = judged.filter(e => isIndexed(e.coverageState)).length;
      const share = indexed / judged.length;
      if (share < SITE_OPEN_BELOW) open('site_not_indexed', 'site_not_indexed', { indexed, total: judged.length });
      else if (share >= SITE_RESOLVE_FROM) close('site_not_indexed');
    }
  }

  const trafficDrop = next.open.find(a => a.id === 'traffic_drop');
  if (trafficDrop && traffic) {
    if (trafficRecovered(trafficDrop, traffic)) close('traffic_drop');
  } else if (traffic?.status === 'insufficient') {
    next.traffic_pending = null;
  } else if (traffic?.status === 'ok') {
    if (traffic.drop > DROP_OPEN) {
      next.traffic_pending = bumpPending(next.traffic_pending, today);
      if (next.traffic_pending.count >= OPEN_AFTER_DAYS) {
        open('traffic_drop', 'traffic_drop', `${Math.round(traffic.drop * 100)} percent fewer landing page impressions (${traffic.current} vs ${traffic.previous} in the 7 days before)`, { reference: traffic.previous });
        next.traffic_pending = null;
      }
    } else {
      next.traffic_pending = null;
    }
  }

  if (liveChecks) {
    const pending = { ...(next.deploy_pending ?? {}) };
    const listed = new Set(liveChecks.map(c => c.key));
    for (const { key, url, ok, removed } of liveChecks) {
      const id = `not_deployed:${key}`;
      if (removed) {
        delete pending[key];
        close(id, 'removed');
        continue;
      }
      if (ok === null) continue;
      if (ok) {
        delete pending[key];
        close(id);
      } else if (!isOpen(id)) {
        pending[key] = bumpPending(pending[key], today);
        if (pending[key].count >= DEPLOY_OPEN_AFTER_DAYS) {
          open(id, 'not_deployed', url);
          delete pending[key];
        }
      }
    }
    for (const key of Object.keys(pending).filter(k => !listed.has(k))) delete pending[key];
    if (Object.keys(pending).length) next.deploy_pending = pending;
    else delete next.deploy_pending;
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
