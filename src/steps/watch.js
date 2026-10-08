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
import { siteUrl, knowsSite, getUserSites, getCrawlIssues, getUrlInfo, isCrawled, normalizeUrl } from '../lib/bing.js';
import { loadAlerts, saveAlerts, trafficWindows, trafficChange, evaluateWatch } from '../lib/watch.js';

// A clean alert that stays unindexed must not make Google and IndexNow hear from us every day.
const RESUBMIT_EVERY_DAYS = 7;

// Landing page rows of one window; rows that map to no known landing page are not ours to watch.
// Overlay pages (shop) are not landing pages: their traffic is not part of the landing page totals.
async function landingRows(config, window, slugsByLocale) {
  const rows = await queryPageTotals(config.gsc_property, { ...window, pageFilter: config.base_url || null });
  return rows.filter((r) => {
    const page = urlToSlug(r.url, config, slugsByLocale);
    return page !== null && !page.overlay;
  });
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

// Does the change behind a key still exist in the repo: the overlay file or the default-locale landing file.
function hasLocalFile(key, config, cwd) {
  const file = parseOverlayKey(key)
    ? overlayFilePath(config, key)
    : `${localeLandingPath(config, defaultLocale(config)).replace(/^\.\//, '').replace(/\/+$/, '')}/${key}.md`;
  return Boolean(file) && existsSync(join(cwd, file));
}

// `liveChecks` for evaluateWatch: seo PRs of the repo merged between 14 days and 24 hours ago, read from
// GitHub (the watcher must see a missed deploy within days, the ledger only fills weekly). Null unless
// `watch.check_deploy` is on. A fetch that fails decides nothing and is a warning; a GitHub error throws.
async function checkDeploys({ config, cwd, now, warnings, fetchPage, listPRs, openAlerts }) {
  if (!config.watch?.check_deploy) return null;
  const since = new Date(now - DEPLOY_CHECK_UNTIL_DAYS * DAY_MS).toISOString();
  const until = new Date(now - DEPLOY_CHECK_FROM_HOURS * HOUR_MS).toISOString();
  const prs = (await listPRs(config.repo, since)).filter(pr => pr.mergedAt <= until);
  const targets = new Map(prs.flatMap(pr => expectedLive(pr, config)).map(t => [t.key, t]));
  // An open alert is checked until it passes, also after its PR left the 14-day window; a file that
  // left the repo ends it as `removed`.
  const checks = [];
  for (const alert of openAlerts.filter(a => a.kind === 'not_deployed')) {
    const key = alert.id.slice('not_deployed:'.length);
    if (targets.has(key)) continue;
    if (!hasLocalFile(key, config, cwd)) checks.push({ key, url: alert.detail, ok: null, removed: true });
    else targets.set(key, { key, url: alert.detail });
  }
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

// Bing URL checks per day: the sitemap is covered section by section.
const BING_URLS_PER_DAY = 30;

// Today's section of the sorted sitemap, stateless: the start moves by 30 per day and wraps around.
function bingSection(urls, today) {
  const sorted = [...urls].sort();
  const day = Math.floor(Date.parse(`${today}T00:00:00Z`) / DAY_MS);
  const start = (day * BING_URLS_PER_DAY) % (sorted.length || 1);
  return Array.from({ length: Math.min(BING_URLS_PER_DAY, sorted.length) }, (_, i) => sorted[(start + i) % sorted.length]);
}

// `bing` input of evaluateWatch, see there. Live calls, no cache. A site Bing does not know warns once
// (`bing.site_missing_warned` on `state`, saved with the alerts) and costs no further calls that day.
async function checkBing({ config, today, entries, state, warnings, api }) {
  if (!config.bing?.enabled) return { disabled: true };
  if (!entries) return null;
  if (!process.env.BING_WEBMASTER_KEY) {
    warnings.push('bing.enabled is set but BING_WEBMASTER_KEY is missing, skipping the Bing checks');
    return { disabled: true };
  }
  const site = siteUrl(config);
  try {
    if (!knowsSite(await api.getUserSites(), site)) {
      if (!state.bing?.site_missing_warned) {
        warnings.push(`Bing does not know ${site} (yet), skipping the Bing checks`);
        state.bing = { ...state.bing, site_missing_warned: true };
      }
      return null;
    }
    const urls = entries.map(e => e.url);
    const known = new Set(urls.map(normalizeUrl));
    const issues = [...new Set((await api.getCrawlIssues(site)).map(i => i.Url).filter(u => known.has(normalizeUrl(u))))];
    const crawled = {};
    let lastError = null;
    // One failing URL keeps its previous value; a rejected key ends the check at once.
    for (const url of bingSection(urls, today)) {
      try {
        crawled[url] = api.isCrawled(await api.getUrlInfo(site, url));
      } catch (e) {
        if (e.kind === 'key_rejected') throw e;
        lastError = e;
      }
    }
    if (lastError && !Object.keys(crawled).length) throw lastError;
    return { urls, issues, crawled };
  } catch (e) {
    warnings.push(`Bing check failed: ${e.message}`);
    return { error: e.kind ?? 'error' };
  }
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

// A technical cause means the last resubmit did not help; once it is fixed (clean again) the alert
// resubmits again, still bounded by `last_resubmit`.
function resetResubmitOnTechnical(alerts, causeBefore) {
  for (const alert of alerts) {
    if (alert.diagnosis?.cause === 'technical' && causeBefore.get(alert.id) !== 'technical') delete alert.resubmitted_at;
  }
}

/**
 * The daily watcher, no LLM: index status plus landing page traffic against
 * `seo/alerts.json`. A failing check (GSC or auth error) is no alert on its own,
 * two in a row open `watch_blind`; it lands in `errors`, makes the status
 * `failed` and leaves its alerts alone, but the state is still saved. Returns the
 * report: `status` is `failed`, `alert` (something opened), `resolved` (only
 * resolutions) or `watch_ok`.
 */
export async function watch({ config, cwd = process.cwd(), dryRun = false, today = format(new Date()), diagnose = diagnoseAlerts, submit = submitFixes, fetchPage = fetchLive, listPRs = listRecentlyMergedSeoPRs, now = Date.now(), bingApi = { getUserSites, getCrawlIssues, getUrlInfo, isCrawled } }) {
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
    liveChecks = await checkDeploys({ config, cwd, now, warnings, fetchPage, listPRs, openAlerts: state.open });
  } catch (e) {
    warnings.push(`Deploy check failed: ${e.message}`);
  }

  // Bing is a second signal: its trouble is a warning or a `bing_blind` alert, never an error.
  const bing = await checkBing({ config, today, entries, state, warnings, api: bingApi });

  const { state: next, opened, resolved } = evaluateWatch(state, { today, entries, traffic, liveChecks, bing });
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
    const causeBefore = new Map(next.open.map(a => [a.id, a.diagnosis?.cause]));
    const diagnosed = await guarded('Diagnosis', () => diagnose({ alerts: next.open, entries, config, today, bing: bing?.urls ? { site: siteUrl(config), ...bingApi, crawled: bing.crawled } : null }));
    resetResubmitOnTechnical(next.open, causeBefore);
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
