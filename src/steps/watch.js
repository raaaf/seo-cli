import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { defaultLocale } from '../lib/config.js';
import { format } from '../lib/date.js';
import { queryPageTotals } from '../lib/gsc.js';
import { getExistingSlugs } from '../lib/landings.js';
import { urlToSlug } from '../lib/measure.js';
import { loadIndexStatus } from '../lib/index-status.js';
import { checkIndexStatus } from './index-check.js';
import { ALERTS_FILE, emptyAlerts, trafficWindows, trafficChange, evaluateWatch } from '../lib/watch.js';

function loadAlerts(cwd, warnings) {
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
function saveAlerts(state, cwd) {
  const path = join(cwd, ALERTS_FILE);
  const content = JSON.stringify(state, null, 2) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

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

/**
 * The daily watcher, no LLM: index status plus landing page traffic against
 * `seo/alerts.json`. A failing check is a warning, never an alert on its own
 * (two in a row open `watch_blind`). Returns the report: `status` is `alert`
 * (something opened), `resolved` (only resolutions) or `watch_ok`.
 */
export async function watch({ config, cwd = process.cwd(), dryRun = false, today = format(new Date()) }) {
  const warnings = [];
  const state = loadAlerts(cwd, warnings);

  let entries = null;
  try {
    await checkIndexStatus(config, cwd);
    entries = loadIndexStatus(cwd).entries;
  } catch (e) {
    warnings.push(`Index check failed: ${e.message}`);
  }

  let traffic = null;
  try {
    traffic = await checkTraffic(config, cwd, today);
  } catch (e) {
    warnings.push(`Traffic check failed: ${e.message}`);
  }

  const { state: next, opened, resolved } = evaluateWatch(state, { today, entries, traffic });
  if (!dryRun) saveAlerts(next, cwd);

  const status = opened.length ? 'alert' : resolved.length ? 'resolved' : 'watch_ok';
  return {
    status, mode: 'watch', prs: [], alerts: { opened, resolved }, open_alerts: next.open,
    traffic: traffic && { status: traffic.status, drop: traffic.drop }, warnings, errors: [],
  };
}
