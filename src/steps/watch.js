import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultLocale, localeLandingPath, localeUrlPath } from '../lib/config.js';
import { format } from '../lib/date.js';
import { queryPageTotals } from '../lib/gsc.js';
import { getExistingSlugs } from '../lib/landings.js';
import { urlToSlug, addDays, overlayUrl } from '../lib/measure.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { listRecentlyMergedSeoPRs } from '../lib/github.js';
import { parseOverlayKey } from '../lib/improvements.js';
import { overlayFilePath, overlayKeyOfFile, parseOverlay } from './overlay.js';
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

// Merged pages are checked from 24 hours after the merge (deploys are manual) until 14 days after it.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEPLOY_CHECK_FROM_HOURS = 24;
const DEPLOY_CHECK_UNTIL_DAYS = 14;
const LIVE_TIMEOUT_MS = 10_000;
const MAX_LIVE_HTML = 200_000;

/** HEAD or GET of a live URL: `{ status, html }`, html only for GET. Throws on DNS, timeout and the like. */
async function fetchLive(url, { method }) {
  const res = await safeFetch(url, { method, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  return { status: res.status, html: method === 'GET' ? (await res.text()).slice(0, MAX_LIVE_HTML) : '' };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'", '&nbsp;': ' ' };
const pageTitle = (html) => {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  return raw.replace(/&(?:amp|lt|gt|quot|nbsp|#0?39);/g, m => ENTITIES[m]).replace(/\s+/g, ' ').trim();
};

// Is this change live? true/false, or null when the answer does not decide (5xx, 403, missing local file).
// A new page counts as live once a HEAD answers below 400 (404 is the "not deployed" answer); an overlay
// is only live when the page title carries the overlay's meta_title, because the page itself existed before.
async function isLive(entry, { config, cwd, fetchPage }) {
  const key = parseOverlayKey(entry.slug);
  if (!key) {
    const { status } = await fetchPage(entry.urls[0], { method: 'HEAD' });
    return status === 404 ? false : status < 400 ? true : null;
  }
  const file = overlayFilePath(config, entry.slug);
  const path = file && join(cwd, file);
  if (!path || !existsSync(path)) return null;
  const title = parseOverlay(readFileSync(path, 'utf8')).fields.meta_title;
  if (typeof title !== 'string' || !title) return null;
  const { status, html } = await fetchPage(entry.urls[0], { method: 'GET' });
  if (status === 404) return false;
  return status < 400 ? pageTitle(html).includes(title) : null;
}

// What a merged seo PR should have put live, from its changed files: a new landing page (`seo/new/`)
// by its page URL, an overlay file by its overlay key and URL. Rewrites of landing pages are not checked.
function expectedLive(pr, config) {
  const base = String(config.base_url || '').replace(/\/+$/, '');
  const def = defaultLocale(config);
  const landingDir = localeLandingPath(config, def).replace(/^\.\//, '').replace(/\/+$/, '');
  const found = [];
  for (const file of pr.files) {
    const overlay = config.overlays ? overlayKeyOfFile(config, file) : null;
    if (overlay) {
      found.push({ key: overlay, url: overlayUrl(config, overlay) });
    } else if (pr.headRef.startsWith('seo/new/') && file.startsWith(`${landingDir}/`) && file.endsWith('.md') && !file.slice(landingDir.length + 1).includes('/')) {
      const slug = file.slice(landingDir.length + 1, -3);
      found.push({ key: slug, url: base + localeUrlPath(config, slug, def) });
    }
  }
  return found;
}

// `liveChecks` for evaluateWatch: seo PRs of the repo merged between 14 days and 24 hours ago, read from
// GitHub (the watcher must see a missed deploy within days, the ledger only fills weekly). Null unless
// `watch.check_deploy` is on. A fetch that fails decides nothing and is a warning; a GitHub error throws.
async function checkDeploys({ config, cwd, now, warnings, fetchPage, listPRs }) {
  if (!config.watch?.check_deploy) return null;
  const since = new Date(now - DEPLOY_CHECK_UNTIL_DAYS * DAY_MS).toISOString();
  const until = new Date(now - DEPLOY_CHECK_FROM_HOURS * HOUR_MS).toISOString();
  const prs = (await listPRs(config.repo, since)).filter(pr => pr.mergedAt <= until);
  const targets = new Map(prs.flatMap(pr => expectedLive(pr, config)).map(t => [t.key, t]));
  const checks = [];
  for (const { key, url } of targets.values()) {
    try {
      checks.push({ key, url, ok: await isLive({ slug: key, urls: [url] }, { config, cwd, fetchPage }) });
    } catch (e) {
      warnings.push(`Deploy check of ${url} failed: ${e.message}`);
      checks.push({ key, url, ok: null });
    }
  }
  return checks;
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
export async function watch({ config, cwd = process.cwd(), dryRun = false, today = format(new Date()), diagnose = diagnoseAlerts, submit = submitFixes, fetchPage = fetchLive, listPRs = listRecentlyMergedSeoPRs, now = Date.now() }) {
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

  // Opt-in (`watch.check_deploy`). A broken check is a warning and leaves the deploy alerts alone.
  let liveChecks = null;
  try {
    liveChecks = await checkDeploys({ config, cwd, now, warnings, fetchPage, listPRs });
  } catch (e) {
    warnings.push(`Deploy check failed: ${e.message}`);
  }

  const { state: next, opened, resolved } = evaluateWatch(state, { today, entries, traffic, liveChecks });
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
