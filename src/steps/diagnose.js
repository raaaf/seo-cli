import { defaultLocale } from '../lib/config.js';
import { fetchForDiagnosis, diagnoseUrl, sameUrl } from '../lib/diagnose.js';
import { isIndexed } from '../lib/index-status.js';
import { submitSitemap } from '../lib/gsc.js';
import { submitIndexNow } from '../lib/indexnow.js';

// Fetches per run, one after the other: a site that lost its whole index must not cost 100 requests a day.
const MAX_URLS = 10;
const INDEX_KINDS = ['deindexed', 'site_not_indexed'];

// The URLs an index alarm is about: the alarm's own URL, or for the site-level
// alarm every URL that is not indexed (base_url first, then sitemap order).
function alertUrls(alert, entries, config) {
  if (alert.kind === 'deindexed') return [alert.detail];
  const missing = entries.filter(e => !isIndexed(e.coverageState)).map(e => e.url);
  return [...missing.filter(u => sameUrl(u, config.base_url)), ...missing.filter(u => !sameUrl(u, config.base_url))];
}

// First URL of every alert, then the second of every alert, ...: one big alert must not starve the others.
function roundRobin(lists, max) {
  const picked = new Set();
  for (let i = 0; picked.size < max && lists.some(l => i < l.length); i++) {
    for (const list of lists) {
      if (i < list.length && picked.size < max) picked.add(list[i]);
    }
  }
  return [...picked];
}

// technical beats unknown beats clean: one broken URL is enough to call the alert technical.
function alertCause(urls) {
  const causes = urls.map(u => u.cause);
  return ['technical', 'unknown'].find(c => causes.includes(c)) ?? 'clean';
}

const resultKey = ({ cause, codes }) => `${cause}:${codes.join(',')}`;

// Bing's crawl state of one URL: today's value from the watcher when it has one, else a call; null when the call fails (the watcher reports Bing trouble itself).
async function bingState(url, { site, api }) {
  if (typeof api.crawled?.[url] === 'boolean') return { crawled: api.crawled[url] };
  try {
    return { crawled: api.isCrawled(await api.getUrlInfo(site, url)) };
  } catch {
    return null;
  }
}

/**
 * Attaches a technical diagnosis to every open `deindexed` and `site_not_indexed`
 * alert. At most 10 distinct URLs are fetched per run, picked round-robin across the alerts. The diagnosis is merged
 * into the existing alert object (`opened` and `open` share it). Quiet days
 * write nothing: `checked_at` and `urls` move only with `cause` or `codes`, an
 * `unknown` result never replaces a diagnosis, and a changed result needs two
 * runs in a row (`pending_codes`) before it counts. The first diagnosis of an
 * alert counts at once. Returns `{ updated }`: alerts that got their first diagnosis or whose diagnosis changed
 * (the caller drops the ones opened in this run, they are reported as opened).
 *
 * With `bing` (`{ site, getUrlInfo, isCrawled }`) every diagnosed URL also gets `bing: { crawled }`. It is
 * a field of the URL entry, not a finding: `cause`, `codes` and `resultKey` stay as they are, so Bing alone
 * never produces an `updated` report. The field is refreshed on existing entries on every run, when it changed.
 */
export async function diagnoseAlerts({ alerts, entries, config, today, fetch = fetchForDiagnosis, bing = null }) {
  const targets = alerts.filter(a => INDEX_KINDS.includes(a.kind)).map(alert => ({ alert, urls: alertUrls(alert, entries, config) }));
  const checked = roundRobin(targets.map(t => t.urls), MAX_URLS);
  if (!checked.length) return { updated: [] };

  const locale = defaultLocale(config);
  const attempt = async (url) => {
    try {
      return { response: await fetch(url, { locale }) };
    } catch (e) {
      return { response: null, fetchError: e.message };
    }
  };
  const robotsStatus = (await attempt(`${new URL(config.base_url).origin}/robots.txt`)).response?.status ?? null;
  const results = new Map();
  for (const url of checked) {
    const inspection = entries.find(e => e.url === url);
    const bingResult = bing && await bingState(url, { site: bing.site, api: bing });
    results.set(url, { url, ...diagnoseUrl({ url, inspection, ...await attempt(url), robotsStatus }), ...(bingResult && { bing: bingResult }) });
  }

  const updated = [];
  for (const { alert, urls } of targets) {
    const done = urls.filter(u => results.has(u)).map(u => results.get(u));
    if (!done.length) continue;
    const result = {
      cause: alertCause(done),
      codes: [...new Set(done.flatMap(u => u.findings.map(f => f.code)))].sort(),
    };
    const previous = alert.diagnosis;
    for (const entry of previous?.urls ?? []) {
      const fresh = results.get(entry.url)?.bing;
      if (fresh && fresh.crawled !== entry.bing?.crawled) entry.bing = fresh;
    }
    const write = () => Object.assign(alert, { diagnosis: { checked_at: today, ...result, urls: done, ...(done.length < urls.length && { sampled: true }) } });

    if (!previous) {
      write();
      updated.push(alert);
    } else if (resultKey(previous) === resultKey(result)) {
      delete alert.pending_codes;
    } else if (result.cause !== 'unknown') {
      if (alert.pending_codes && resultKey(alert.pending_codes) === resultKey(result)) {
        delete alert.pending_codes;
        write();
        updated.push(alert);
      } else {
        alert.pending_codes = { ...result, date: today };
      }
    }
  }
  return { updated };
}

/** Resubmits the sitemap to Google and, with an IndexNow key, the given URLs to IndexNow. Throws on failure. */
export async function submitFixes({ config, urls }) {
  await submitSitemap(config.gsc_property, `${config.base_url.replace(/\/$/, '')}/sitemap.xml`);
  if (config.indexnow_key) await submitIndexNow({ baseUrl: config.base_url, key: config.indexnow_key, urls });
}
