import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultLocale, localeLandingPath, localeUrlPath, siteInfo } from '../lib/config.js';
import { format } from '../lib/date.js';
import { queryPageTotals } from '../lib/gsc.js';
import { getExistingSlugs, getExistingPages } from '../lib/landings.js';
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
import { AI_BOTS, BROWSER_UA, botUserAgent, robotsRules, robotsAccess, liveVerdict, liveSummary } from '../lib/ai-crawlers.js';
import { pageCheck } from '../lib/structured-data.js';

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

// Bing URL checks per day: the sitemap is covered section by section. Bing throttles GetUrlInfo
// after 10 calls per host (ThrottleHost, measured 2026-10-08), so 10 it is.
const BING_URLS_PER_DAY = 10;

// The sorted list rotated so it starts where today's section starts: the start moves by `step` per day.
function rotated(urls, today, step) {
  const sorted = [...urls].sort();
  const day = Math.floor(Date.parse(`${today}T00:00:00Z`) / DAY_MS);
  const start = (day * step) % (sorted.length || 1);
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

// Today's section of the sorted sitemap, stateless: the start moves by `n` per day and wraps around.
function bingSection(urls, today, n = BING_URLS_PER_DAY) {
  return rotated(urls, today, n).slice(0, n);
}

// Two of the daily Bing checks always go to URLs already seen crawled, so a stale `true` is
// refreshed eventually; the rest go to URLs not yet checked, then to those seen uncrawled. A
// crawled URL rarely turns back, so rechecking them in plain sitemap order took a 500-URL
// sitemap 50 days to reach a page Bing had never been asked about.
const BING_RECHECK_SLOTS = 2;

// Today's Bing URLs: `crawled` is the stored map (url -> boolean), each group in its rotating section.
function bingPicks(urls, crawled = {}, today, n = BING_URLS_PER_DAY) {
  const unknown = urls.filter(u => typeof crawled[u] !== 'boolean');
  const uncrawled = urls.filter(u => crawled[u] === false);
  const seen = urls.filter(u => crawled[u] === true);
  const open = [...rotated(unknown, today, n), ...rotated(uncrawled, today, n)];
  const recheck = rotated(seen, today, n).slice(0, Math.max(BING_RECHECK_SLOTS, n - open.length));
  return [...open.slice(0, n - Math.min(BING_RECHECK_SLOTS, recheck.length)), ...recheck].slice(0, n);
}

// AI crawler access and structured data share one pool of fetches: 5 at a time, 60 s in total, so the slow part
// cannot hold up the alerts. A fetch that fails or misses the deadline has no result and decides nothing.
const CRAWL_CONCURRENCY = 5;
const CRAWL_DEADLINE_MS = 60_000;
const MAX_CRAWL_HTML = 1_000_000;
const STRUCTURED_PAGES_PER_DAY = 10;

/** `{ status, headers (lowercase keys), html, truncated }` of a GET as the given user agent. Throws on DNS, timeout and the like. */
async function fetchAsBot(url, { ua, timeoutMs }) {
  const res = await safeFetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), html: text.slice(0, MAX_CRAWL_HTML), truncated: text.length > MAX_CRAWL_HTML };
}

// Runs the jobs `{ key, url, ua }`; returns a Map key to result for those that answered.
async function fetchPool(jobs, { fetchBot, deadlineMs }) {
  const results = new Map();
  const end = Date.now() + deadlineMs;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const left = end - Date.now();
      if (left <= 0) return;
      try {
        results.set(job.key, await fetchBot(job.url, { ua: job.ua, timeoutMs: Math.min(LIVE_TIMEOUT_MS, left) }));
      } catch {
        // no result: unknown
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, jobs.length) }, worker));
  return results;
}

// Landing pages of the default and the counterpart locale with their public URL and whether the frontmatter has FAQ items.
function landingPages(config, cwd, base) {
  if (!config.landing_path) return [];
  const def = defaultLocale(config);
  const locales = [def, ...(config.counterpart_locale && config.counterpart_locale !== def ? [config.counterpart_locale] : [])];
  return locales.flatMap(locale => getExistingPages(config, cwd, locale).map(p => ({
    slug: p.slug,
    url: `${base}${locale === def ? '' : config.counterpart_url_prefix || ''}/${p.slug}`,
    hasFaq: p.faq.length > 0,
  })));
}

// Pages for the JSON-LD check: the landing pages, or for a project without landing_path every sitemap URL (slug is its
// path). Null when that sitemap is unknown because the index check failed, so the alert stays as it is.
function structuredPages(config, cwd, base, entries) {
  if (config.landing_path) return landingPages(config, cwd, base);
  if (!entries) return null;
  return entries.map(e => ({ slug: new URL(e.url).pathname, url: e.url, hasFaq: false, discovered: true }));
}

// Bots and pages the run could not decide, for one warning.
const undecided = (label, items) => (items.length ? [`${label}: ${items.join(', ')}`] : []);

// `aiCrawlers` and `structuredData` inputs of evaluateWatch (see there) plus their report parts. The switches are
// `watch.ai_crawlers` and `watch.structured_data`; a switched-off check is `{ disabled: true }` and fetches nothing.
// Per run: robots.txt, the home page and one rotating page as each search bot and as a browser, and up to 10
// landing pages, or sitemap URLs without landing_path (plus those with an open or pending finding), for their JSON-LD.
async function checkCrawl({ config, cwd, today, entries, state, warnings, fetchBot, deadlineMs }) {
  const wantAi = Boolean(config.watch?.ai_crawlers);
  const wantData = Boolean(config.watch?.structured_data);
  const base = String(config.base_url || '').replace(/\/+$/, '');
  const idle = (want) => (want ? null : { disabled: true });
  if (!base || !(wantAi || wantData)) return { aiCrawlers: idle(wantAi), structuredData: idle(wantData), report: {} };

  const sitemapUrls = (entries ?? []).map(e => e.url);
  const jobs = [];
  const liveUrls = [...new Set([`${base}/`, ...bingSection(sitemapUrls, today, 1)])];
  if (wantAi) {
    jobs.push({ key: 'robots', url: `${base}/robots.txt`, ua: BROWSER_UA });
    for (const url of liveUrls) jobs.push({ key: `browser:${url}`, url, ua: BROWSER_UA });
    for (const bot of AI_BOTS.filter(b => b.live)) {
      for (const url of liveUrls) jobs.push({ key: `${bot.token}:${url}`, url, ua: botUserAgent(bot.token) });
    }
  }
  const pages = wantData ? structuredPages(config, cwd, base, entries) : [];
  const tracked = new Set([...(state.open.find(a => a.id === 'structured_data')?.detail ?? []).map(d => d.slug), ...Object.keys(state.structured_data?.pending ?? {})]);
  const today10 = new Set(bingSection((pages ?? []).map(p => p.url), today, STRUCTURED_PAGES_PER_DAY));
  const fetched = (pages ?? []).filter(p => today10.has(p.url) || tracked.has(p.slug));
  for (const p of fetched) jobs.push({ key: `data:${p.slug}`, url: p.url, ua: BROWSER_UA });
  const results = await fetchPool(jobs, { fetchBot, deadlineMs });
  const report = {};
  let aiCrawlers = { disabled: true };
  let structuredData = { disabled: true };

  if (wantAi) {
    const robots = results.get('robots');
    const groups = robots ? robotsRules(robots.status, robots.html) : null;
    const paths = [...new Set(['/', ...sitemapUrls.map(u => { const x = new URL(u); return x.pathname + x.search; })])];
    const bots = AI_BOTS.map((bot) => {
      const access = bot.robots ? robotsAccess(groups, bot.token, paths) : null;
      // Without the sitemap only `/` was judged: `allowed` there says nothing about the sitemap paths of an open alert.
      if (access && !entries && access.verdict === 'allowed') access.verdict = 'unknown';
      const live = bot.live ? liveSummary(liveUrls.map(url => liveVerdict({ bot: results.get(`${bot.token}:${url}`) ?? null, browser: results.get(`browser:${url}`) ?? null }))) : null;
      return { token: bot.token, kind: bot.kind, robots: access?.verdict ?? null, paths: access?.paths ?? [], live: live?.verdict ?? null, status: live?.status ?? null };
    });
    const ignore = Array.isArray(config.watch.ai_crawlers_ignore) ? config.watch.ai_crawlers_ignore : [];
    const search = bots.filter(b => b.kind === 'search');
    const watched = search.filter(b => !ignore.includes(b.token));
    aiCrawlers = { bots, ignore };
    report.ai_crawlers = {
      robots: robots?.status ?? null,
      search: search.map(({ token, robots: verdict, paths: blocked, live, status }) => ({ token, robots: verdict, paths: blocked, live, status })),
      training: bots.filter(b => b.kind === 'training').map(({ token, robots: verdict, paths: blocked }) => ({ token, robots: verdict, paths: blocked })),
    };
    warnings.push(
      ...undecided('AI bots blocked live but never seen ok from this runner, report only', watched.filter(b => b.live === 'blocked' && !state.ai_crawlers?.ok_seen?.[b.token]).map(b => b.token)),
      ...undecided('AI crawler check could not decide for bots', watched.filter(b => b.live === 'unknown' || b.robots === 'unknown').map(b => b.token)),
    );
  }

  if (wantData && !pages) structuredData = null;
  if (wantData && pages) {
    const checked = fetched.map((p) => {
      const res = results.get(`data:${p.slug}`);
      const ok = res && res.status >= 200 && res.status < 300;
      const page = ok ? pageCheck({ html: res.html, headers: res.headers, url: p.url, hasFaq: p.hasFaq, truncated: res.truncated }) : null;
      // A sitemap-discovered page (legal pages, app pages) may legitimately carry no JSON-LD: report only, no alert.
      const soft = p.discovered && page?.codes.includes('jsonld_missing');
      return {
        slug: p.slug,
        codes: soft ? page.codes.filter(c => c !== 'jsonld_missing') : page?.codes ?? null,
        recommended: soft ? ['jsonld_missing', ...page.recommended] : page?.recommended ?? [],
      };
    });
    structuredData = { slugs: pages.map(p => p.slug), results: checked.map(({ slug, codes }) => ({ slug, codes })) };
    report.structured_data = {
      checked: checked.filter(r => r.codes !== null).length,
      findings: checked.filter(r => r.codes?.length).map(({ slug, codes }) => ({ slug, codes })),
      // Search Console's non-critical issues and missing on-page signals: report only, never an alert.
      recommended: checked.filter(r => r.recommended.length).map(({ slug, recommended }) => ({ slug, fields: recommended })),
    };
    warnings.push(...undecided('Structured data check could not decide for pages', checked.filter(r => r.codes === null).map(r => r.slug)));
  }
  return { aiCrawlers, structuredData, report };
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
    for (const url of bingPicks(urls, state.bing?.crawled, today)) {
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
export async function watch({ config, cwd = process.cwd(), dryRun = false, today = format(new Date()), diagnose = diagnoseAlerts, submit = submitFixes, fetchPage = fetchLive, listPRs = listRecentlyMergedSeoPRs, now = Date.now(), bingApi = { getUserSites, getCrawlIssues, getUrlInfo, isCrawled }, fetchBot = fetchAsBot, crawlDeadlineMs = CRAWL_DEADLINE_MS }) {
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

  // AI crawler access and structured data, like Bing: warnings, never errors, never `watch_blind`.
  let crawl = { aiCrawlers: null, structuredData: null, report: {} };
  try {
    crawl = await checkCrawl({ config, cwd, today, entries, state, warnings, fetchBot, deadlineMs: crawlDeadlineMs });
  } catch (e) {
    warnings.push(`AI crawler and structured data checks failed: ${e.message}`);
  }

  const { state: next, opened, resolved, updated: changed } = evaluateWatch(state, { today, entries, traffic, liveChecks, bing, aiCrawlers: crawl.aiCrawlers, structuredData: crawl.structuredData });
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
  let updated = changed;
  let resubmitted = [];
  if (entries) {
    const causeBefore = new Map(next.open.map(a => [a.id, a.diagnosis?.cause]));
    const diagnosed = await guarded('Diagnosis', () => diagnose({ alerts: next.open, entries, config, today, bing: bing?.urls ? { site: siteUrl(config), ...bingApi, crawled: bing.crawled } : null }));
    resetResubmitOnTechnical(next.open, causeBefore);
    updated = [...changed, ...(diagnosed?.updated ?? []).filter(a => !opened.includes(a))];
    if (!dryRun) resubmitted = (await guarded('Resubmit', () => resubmitClean(next, { config, today, submit }))) ?? [];
    if (!dryRun) saveAlerts(next, cwd);
  }

  // A failed check is the loudest outcome: the report says so even when alerts opened too.
  const status = errors.length ? 'failed' : opened.length || updated.length ? 'alert' : resolved.length ? 'resolved' : 'watch_ok';
  return {
    status, mode: 'watch', prs: [], site: siteInfo(config), alerts: { opened, updated, resolved, resubmitted }, open_alerts: next.open,
    traffic: traffic && { status: traffic.status, drop: traffic.drop }, ...crawl.report, warnings, errors,
  };
}
