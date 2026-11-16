import { addDays } from './measure.js';

// An alert is assessed (and a page next to a merge is rewritten) only once Google had a chance to recrawl.
// Bounded: after this many days the wait ends anyway, the stored crawl time can lag.
export const REASSESS_AFTER_DAYS = 28;

export const trimSlash = u => String(u).replace(/\/+$/, '');

/** Newest merge of any age that concerns the alert: any entry for site_not_indexed, else entries touching one of its URLs. Null when there is none. */
export function lastChangeDate(alert, ledger) {
  const urls = new Set((alert.diagnosis?.urls ?? []).map(u => trimSlash(u.url)));
  return ledger
    .filter(e => alert.kind === 'site_not_indexed' || (e.urls ?? []).some(u => urls.has(trimSlash(u))))
    .map(e => e.merged_at).filter(Boolean).sort().at(-1) ?? null;
}

/** Waiting for a recrawl: the change is younger than REASSESS_AFTER_DAYS and no URL of the alert shows a crawl after it. */
export function isWaiting(alert, lastChange, entries, today) {
  if (!lastChange || lastChange <= addDays(today, -REASSESS_AFTER_DAYS)) return false;
  const urls = new Set(alert.diagnosis.urls.map(u => u.url));
  return !entries.some(e => urls.has(e.url) && e.lastCrawlTime && e.lastCrawlTime.slice(0, 10) > lastChange);
}
