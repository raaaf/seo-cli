import { defaultLocale } from '../lib/config.js';
import { format } from '../lib/date.js';
import { queryPageTotals } from '../lib/gsc.js';
import { getExistingSlugs } from '../lib/landings.js';
import { urlToSlug, addDays } from '../lib/measure.js';
import { loadIndexStatus } from '../lib/index-status.js';
import { checkIndexStatus } from './index-check.js';
import { diagnoseAlerts, submitFixes } from './diagnose.js';
import { loadAlerts, saveAlerts, trafficWindows, trafficChange, evaluateWatch } from '../lib/watch.js';

// A clean alert that stays unindexed must not make Google and IndexNow hear from us every day.
const RESUBMIT_EVERY_DAYS = 7;

// Landing page rows of one window; rows that map to no known landing page are not ours to watch.
async function landingRows(config, window, slugsByLocale) {
  const rows = await queryPageTotals(config.gsc_property, { ...window, pageFilter: config.base_url || null });
  return rows.filter(r => urlToSlug(r.url, config, slugsByLocale) !== null);
}

async function checkTraffic(config, cwd, today) {
  const def = defaultLocale(config);
  const slugsByLocale = { [def]: getExistingSlugs(config, cwd, def) };
  if (config.counterpart_locale && config.counterpart_locale !== def) {
    slugsByLocale[config.counterpart_locale] = getExistingSlugs(config, cwd, config.counterpart_locale);
  }
  const windows = trafficWindows(today);
  const current = await landingRows(config, windows.current, slugsByLocale);
  const previous = await landingRows(config, windows.previous, slugsByLocale);
  return trafficChange(current, previous);
}

// Sitemap and IndexNow once for all alerts whose live fetch is clean, at most every 7 days.
// Throws before anything is set, so a failed submit is tried again next run.
async function resubmitClean(state, { config, today, submit }) {
  const due = state.open.filter(a => a.diagnosis?.cause === 'clean' && !a.resubmitted_at);
  if (!due.length || (state.last_resubmit && state.last_resubmit > addDays(today, -RESUBMIT_EVERY_DAYS))) return [];
  await submit({ config, urls: [...new Set(due.flatMap(a => a.diagnosis.urls.map(u => u.url)))] });
  for (const alert of due) alert.resubmitted_at = today;
  state.last_resubmit = today;
  return due.map(a => a.id);
}

/**
 * The daily watcher, no LLM: index status plus landing page traffic against
 * `seo/alerts.json`. A failing check (GSC or auth error) is no alert on its own,
 * two in a row open `watch_blind`; it lands in `errors`, makes the status
 * `failed` and leaves its alerts alone, but the state is still saved. Returns the
 * report: `status` is `failed`, `alert` (something opened), `resolved` (only
 * resolutions) or `watch_ok`.
 */
export async function watch({ config, cwd = process.cwd(), dryRun = false, today = format(new Date()), diagnose = diagnoseAlerts, submit = submitFixes }) {
  const warnings = [];
  const state = loadAlerts(cwd, warnings);

  const errors = [];
  let entries = null;
  try {
    const checked = await checkIndexStatus(config, cwd, { dryRun });
    // A dry run saved nothing, so the file would still hold the previous snapshot.
    entries = dryRun ? checked.current : loadIndexStatus(cwd).entries;
  } catch (e) {
    errors.push(`Index check failed: ${e.message}`);
  }

  let traffic = null;
  try {
    traffic = await checkTraffic(config, cwd, today);
  } catch (e) {
    errors.push(`Traffic check failed: ${e.message}`);
  }

  const { state: next, opened, resolved } = evaluateWatch(state, { today, entries, traffic });
  // Saved before the slow part, so a hanging fetch cannot lose the alerts.
  if (!dryRun) saveAlerts(next, cwd);

  // Diagnosis problems are warnings, never errors: the alerts stand without them.
  const guarded = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${label} failed: ${e.message}`);
      return null;
    }
  };
  let updated = [];
  let resubmitted = [];
  if (entries) {
    const diagnosed = await guarded('Diagnosis', () => diagnose({ alerts: next.open, entries, config, today }));
    updated = (diagnosed?.updated ?? []).filter(a => !opened.includes(a));
    if (!dryRun) resubmitted = (await guarded('Resubmit', () => resubmitClean(next, { config, today, submit }))) ?? [];
    if (!dryRun) saveAlerts(next, cwd);
  }

  // A failed check is the loudest outcome: the report says so even when alerts opened too.
  const status = errors.length ? 'failed' : opened.length || updated.length ? 'alert' : resolved.length ? 'resolved' : 'watch_ok';
  return {
    status, mode: 'watch', prs: [], alerts: { opened, updated, resolved, resubmitted }, open_alerts: next.open,
    traffic: traffic && { status: traffic.status, drop: traffic.drop }, warnings, errors,
  };
}
