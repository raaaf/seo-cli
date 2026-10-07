import { defaultLocale } from './config.js';
import { overlayKey, parseOverlayKey } from './improvements.js';

// Pure rules of the measurement: windows, URL mapping, control group, verdict.
// No I/O, GSC access lives in steps/measure.js.

const DAY_MS = 24 * 60 * 60 * 1000;

// GSC data lags by about three days, a window is only complete after that.
const GSC_LAG_DAYS = 3;
const MIN_TARGET_IMPRESSIONS = 100;
const MIN_CONTROLS = 12;
const MIN_CONTROL_IMPRESSIONS = 50;
const CLICKS_METRIC_FROM = 20;
const MAX_DISPERSION = 4;
const MIN_EFFECT_POSITIVE = 1.3;
const MAX_EFFECT_NEGATIVE = 0.7;
const MAX_REVERT_EFFECT = 0.7;

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Windows around a merge date. The first 7 days after the merge count for
 * nothing (deploy, recrawl); both readings share the 28 days before the merge.
 */
export function windowsFor(mergedAt) {
  return {
    baseline: { startDate: addDays(mergedAt, -28), endDate: addDays(mergedAt, -1) },
    d28: { startDate: addDays(mergedAt, 8), endDate: addDays(mergedAt, 35) },
    d56: { startDate: addDays(mergedAt, 36), endDate: addDays(mergedAt, 63) },
  };
}

/** A window is due once its end lies at least 3 days before `today` (YYYY-MM-DD). */
export function isDue(window, today) {
  return addDays(window.endDate, GSC_LAG_DAYS) <= today;
}

export function normalizeUrl(url) {
  const raw = String(url || '');
  // The one query string that names a page: a shop category (/shop?category=<key>).
  const category = raw.match(/\/shop\/?\?(?:[^#]*&)?category=([^&#]+)/)?.[1];
  const clean = raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return category ? `${clean}?category=${category}` : clean;
}

/** Public URL of an overlay key, on `base_url`. */
export function overlayUrl(config, key) {
  const { type, id } = parseOverlayKey(key);
  const base = String(config.base_url || '').replace(/\/+$/, '');
  return type === 'product' ? `${base}/shop/${id}` : `${base}/shop?category=${id}`;
}

// Overlay key of a site path, only for the kinds the project configured.
function pathToOverlayKey(path, overlays) {
  const product = overlays.products && path.match(/^\/shop\/([^/?]+)$/);
  if (product) return overlayKey('product', product[1]);
  const category = overlays.categories && path.match(/^\/shop\?category=([^&]+)$/);
  return category ? overlayKey('category', category[1]) : null;
}

/**
 * Maps a GSC URL to a known landing page: { slug, locale }, or null for the
 * homepage, the pricing page, the blog and everything else that is not a
 * landing page. The counterpart prefix is stripped for the counterpart locale.
 */
export function urlToSlug(url, config, slugsByLocale) {
  const base = String(config.base_url || '').replace(/\/+$/, '');
  const clean = normalizeUrl(url);
  if (!base || !clean.startsWith(`${base}/`)) return null;
  const path = clean.slice(base.length);
  const def = defaultLocale(config);
  const overlay = config.overlays ? pathToOverlayKey(path, config.overlays) : null;
  if (overlay) return { slug: overlay, locale: def, overlay: true };
  const counterpart = config.counterpart_locale && config.counterpart_locale !== def ? config.counterpart_locale : null;
  const prefix = config.counterpart_url_prefix || '';

  if (counterpart && prefix && path.startsWith(`${prefix}/`)) {
    const slug = path.slice(prefix.length + 1);
    return slugsByLocale[counterpart]?.includes(slug) ? { slug, locale: counterpart } : null;
  }
  const slug = path.slice(1);
  if (slugsByLocale[def]?.includes(slug)) return { slug, locale: def };
  if (counterpart && !prefix && slugsByLocale[counterpart]?.includes(slug)) return { slug, locale: counterpart };
  return null;
}

/** Sums rows per normalized URL: clicks, impressions, CTR, impression-weighted position. */
export function aggregatePages(rows) {
  const sums = new Map();
  for (const row of rows) {
    const key = normalizeUrl(row.url);
    const s = sums.get(key) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
    s.clicks += row.clicks;
    s.impressions += row.impressions;
    s.weightedPosition += row.position * row.impressions;
    sums.set(key, s);
  }
  return new Map([...sums].map(([key, s]) => [key, metricsOf(s)]));
}

/** Metrics of several pages together, from per-page metrics. */
export function sumMetrics(list) {
  const s = { clicks: 0, impressions: 0, weightedPosition: 0 };
  for (const m of list) {
    s.clicks += m.clicks;
    s.impressions += m.impressions;
    s.weightedPosition += m.position * m.impressions;
  }
  return metricsOf(s);
}

function metricsOf({ clicks, impressions, weightedPosition }) {
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  };
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Control pages for a rewrite. `candidates`: [{ key, impressions }] with the
 * baseline impressions of every unchanged landing page of the same language.
 * First choice: pages between half and double the target's level. With fewer
 * than 12 of those, every page with at least 50 impressions.
 */
export function selectControls(targetImpressions, candidates) {
  const similar = candidates.filter(c => c.impressions >= targetImpressions / 2 && c.impressions <= targetImpressions * 2);
  if (similar.length >= MIN_CONTROLS) return similar;
  return candidates.filter(c => c.impressions >= MIN_CONTROL_IMPRESSIONS);
}

/**
 * Verdict for a rewrite, a hint and not a proof: `improve` picks pages with an
 * outlier in the data, so part of any movement afterwards is regression to the
 * mean, hence the strict limits. `target` and every control carry
 * `{ before, after }` with clicks and impressions.
 */
export function verdictFor({ target, controls }) {
  const insufficient = (reason) => ({ verdict: 'insufficient_data', reason });
  // Only the baseline gates: a page that collapses after the rewrite has to stay measurable.
  if (target.before.impressions < MIN_TARGET_IMPRESSIONS) return insufficient('volume');
  if (controls.length < MIN_CONTROLS) return insufficient('control');

  const metric = target.before.clicks >= CLICKS_METRIC_FROM ? 'clicks' : 'impressions';
  const ratio = (p) => (p.after[metric] + 1) / (p.before[metric] + 1);
  const ratios = controls.map(ratio);
  const p10 = quantile(ratios, 0.1);
  const p90 = quantile(ratios, 0.9);
  if (p90 / p10 > MAX_DISPERSION) return insufficient('dispersion');

  const r = ratio(target);
  const median = quantile(ratios, 0.5);
  const effect = r / median;
  let verdict = 'neutral';
  if (r > p90 && effect >= MIN_EFFECT_POSITIVE) verdict = 'positive';
  else if (r < p10 && effect <= MAX_EFFECT_NEGATIVE) verdict = 'negative';
  return { verdict, metric, r, median, p10, p90, controls: controls.length, effect };
}

/**
 * True when another entry for the same page (rewrite or counterpart) merged
 * inside `window`, which spans the baseline and the measurement window.
 */
export function isOverlap(entry, entries, window) {
  const mine = new Set(entry.urls.map(normalizeUrl));
  return entries.some(other => other.id !== entry.id
    && other.merged_at >= window.startDate && other.merged_at <= window.endDate
    && other.urls.some(u => mine.has(normalizeUrl(u))));
}

/** Two negative readings and a strong effect in the second. Etappe C acts on it. */
export function isRevertCandidate(entry) {
  const { d28, d56 } = entry.readings;
  return d28?.verdict === 'negative' && d56?.verdict === 'negative' && d56.effect <= MAX_REVERT_EFFECT;
}
