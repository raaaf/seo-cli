import chalk from 'chalk';
import { defaultLocale } from '../lib/config.js';
import { loadChanges, saveChanges } from '../lib/changes.js';
import { queryPageTotals } from '../lib/gsc.js';
import { format } from '../lib/date.js';
import { parseOverlayKey } from '../lib/improvements.js';
import { rybbitActive, landingSlugs, getRybbitStats, readingStats } from '../lib/signals/rybbit.js';
import {
  addDays, windowsFor, isDue, normalizeUrl, urlToSlug, aggregatePages, sumMetrics, selectControls,
  verdictFor, isOverlap, isRevertCandidate, MIN_CONTROLS,
} from '../lib/measure.js';

const READINGS = ['d28', 'd56'];
// Readings older than this are not completed with Rybbit values afterwards.
const BACKFILL_DAYS = 90;
const NONE = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/**
 * Computes every due, still empty reading of the change ledger and saves it.
 * Rewrites get a verdict against matched control pages, new pages their absolute
 * values. Costs GSC queries only. A failing reading is a warning, the run goes on.
 * Returns the `measurement` section of the run report.
 */
export async function measure({ config, cwd = process.cwd(), dryRun = false, warnings = [], today = format(new Date()) }) {
  const changes = loadChanges(cwd);
  const def = defaultLocale(config);
  const slugsByLocale = landingSlugs(config, cwd);
  const rybbitOn = rybbitActive(config, warnings);

  // Known landing pages with their totals in one window, and in `others` every other URL of the site
  // (the control fallback). A window without a single impression means a wrong property or an
  // outage, never a measurement.
  async function windowPages(window) {
    const rows = await queryPageTotals(config.gsc_property, { ...window, pageFilter: config.base_url || null });
    const pages = new Map();
    const others = new Map();
    for (const [url, totals] of aggregatePages(rows)) {
      const page = urlToSlug(url, config, slugsByLocale);
      if (page) pages.set(url, { ...page, ...totals });
      else others.set(url, totals);
    }
    if (![...pages.values()].some(p => p.impressions > 0)) {
      throw new Error(`GSC returned no landing page impressions for ${window.startDate} to ${window.endDate}`);
    }
    return { pages, others };
  }

  // A page whose URL maps to no known landing page (slug gone, other URL scheme) cannot be measured.
  const isMapped = (url) => urlToSlug(url, config, slugsByLocale) !== null;
  const isUnmapped = (entry) => entry.kind === 'new' ? !entry.urls.some(isMapped) : !isMapped(entry.urls[0]);

  // Rybbit values of an entry's pages in a reading window. Never throws: `null` marks a gap for the backfill.
  async function rybbitFor(entry, window) {
    const keys = new Set(entry.urls.map(u => urlToSlug(u, config, slugsByLocale)).filter(Boolean).map(p => `${p.locale}:${p.slug}`));
    const stats = await getRybbitStats({ config, cwd, window, slugsByLocale, warnings, dryRun, goalKeys: keys, sources: false });
    return stats.error ? null : readingStats(stats.pages, keys);
  }

  // Every reading carries its Rybbit values (the GSC verdict never depends on them).
  async function measureEntry(entry, key) {
    const reading = await measureGsc(entry, key);
    return rybbitOn ? { ...reading, rybbit: await rybbitFor(entry, reading.window) } : reading;
  }

  async function measureGsc(entry, key) {
    const windows = windowsFor(entry.merged_at);
    const window = windows[key];
    const reading = { measured_at: today, window };

    if (entry.kind === 'new') {
      const { pages } = await windowPages(window);
      return { ...reading, ...sumMetrics(entry.urls.map(u => pages.get(normalizeUrl(u)) ?? NONE)) };
    }

    if (isOverlap(entry, changes.entries, { startDate: windows.baseline.startDate, endDate: window.endDate })) {
      return { ...reading, verdict: 'insufficient_data', reason: 'overlap' };
    }
    const { pages: baselinePages, others: baselineOthers } = await windowPages(windows.baseline);
    const { pages: afterPages, others: afterOthers } = await windowPages(window);
    const target = normalizeUrl(entry.urls[0]);
    entry.baseline ??= { window: windows.baseline, ...(baselinePages.get(target) ?? NONE) };
    // A row with small numbers is a real value; no row at all is not a zero.
    if (entry.baseline.impressions > 0 && !afterPages.has(target)) {
      return { ...reading, verdict: 'insufficient_data', reason: 'missing' };
    }
    const after = afterPages.get(target) ?? NONE;

    // Pages touched near this one, counterparts included, are no control.
    const touched = new Set(changes.entries
      .filter(e => e.merged_at >= windows.baseline.startDate && e.merged_at <= windows.d56.endDate)
      .flatMap(e => e.urls.map(normalizeUrl)));
    // Overlays are compared with overlays, landing pages with landing pages.
    const isOverlay = parseOverlayKey(entry.slug) !== null;
    const candidates = [...baselinePages]
      .filter(([url, page]) => page.locale === def && !touched.has(url) && Boolean(page.overlay) === isOverlay)
      .map(([url, page]) => ({ key: url, impressions: page.impressions }));
    let picked = selectControls(entry.baseline.impressions, candidates);
    // Fewer than 12 landing controls: the other URLs of the site join them (blog, home, tools), a looser
    // comparison that is marked on the reading and never leads to a revert.
    let fromSite = false;
    if (!isOverlay && picked.length < MIN_CONTROLS) {
      const site = [...baselineOthers].filter(([url]) => !touched.has(url)).map(([url, page]) => ({ key: url, impressions: page.impressions }));
      const combined = selectControls(entry.baseline.impressions, [...candidates, ...site]);
      if (combined.some(c => baselineOthers.has(c.key))) { picked = combined; fromSite = true; }
    }
    const beforeAll = new Map([...baselinePages, ...baselineOthers]);
    const afterAll = new Map([...afterPages, ...afterOthers]);
    const controls = picked.map(c => ({ before: beforeAll.get(c.key), after: afterAll.get(c.key) ?? NONE }));
    const verdict = verdictFor({ target: { before: entry.baseline, after }, controls, siteControls: fromSite });

    return { ...reading, ...after, ...verdict, ...(fromSite ? { controls_source: 'site' } : {}) };
  }

  let due = 0;
  let dirty = false;
  const fresh = new Set();
  const changed = [];
  for (const entry of changes.entries) {
    const windows = windowsFor(entry.merged_at);
    for (const key of READINGS) {
      if (entry.unmapped) break;
      if (entry.readings[key] || !isDue(windows[key], today)) continue;
      if (isUnmapped(entry)) {
        entry.unmapped = true;
        dirty = true;
        warnings.push(`Measurement of ${entry.slug} skipped: its URL maps to no landing page`);
        break;
      }
      due++;
      try {
        entry.readings[key] = await measureEntry(entry, key);
        fresh.add(entry.readings[key]);
        dirty = true;
        changed.push({ slug: entry.slug, kind: entry.kind, reading: key, verdict: entry.readings[key].verdict ?? null });
      } catch (e) {
        warnings.push(`Measurement of ${entry.slug} (${key}) failed: ${e.message}`);
      }
      // d56 only after d28 exists, so the revert rule sees both readings in order.
      if (!entry.readings[key]) break;
    }
    // Gaps from an earlier Rybbit outage: only the field is filled in, verdict and GSC values stay.
    if (rybbitOn && !entry.unmapped) {
      for (const key of READINGS) {
        const reading = entry.readings[key];
        const gap = reading?.rybbit === null || (reading?.rybbit && (reading.rybbit.macro === null || reading.rybbit.micro === null));
        if (!gap || fresh.has(reading) || reading.window.endDate < addDays(today, -BACKFILL_DAYS)) continue;
        const filled = await rybbitFor(entry, reading.window);
        if (filled !== null && JSON.stringify(filled) !== JSON.stringify(reading.rybbit)) {
          reading.rybbit = filled;
          dirty = true;
        }
      }
    }
    if ((entry.kind === 'rewrite' || entry.kind === 'snippet') && !entry.revert_candidate && isRevertCandidate(entry)) {
      entry.revert_candidate = true;
      dirty = true;
      warnings.push(`Revert candidate: ${entry.slug} measured negative after 28 and 56 days (${entry.pr_url})`);
    }
  }

  if (dirty && !dryRun) {
    try {
      saveChanges(changes, cwd);
    } catch (e) {
      warnings.push(`Change ledger not saved: ${e.message}`);
    }
  }
  if (changed.length > 0) console.log(chalk.gray(`  Measured ${changed.length} of ${due} due reading(s).`));

  const readings = changes.entries.flatMap(e => READINGS.map(k => e.readings[k]).filter(r => r?.verdict));
  const tally = (field, values) => Object.fromEntries(values.map(v => [v, readings.filter(r => r[field] === v).length]));
  return {
    entries: changes.entries.length,
    due,
    measured: changed.length,
    verdicts: tally('verdict', ['positive', 'neutral', 'negative', 'insufficient_data']),
    insufficient_by_reason: {
      ...tally('reason', ['volume', 'control', 'dispersion', 'overlap', 'missing']),
      unmapped: changes.entries.filter(e => e.unmapped).length,
    },
    revert_candidates: changes.entries.filter(e => e.revert_candidate).map(e => e.slug),
    changed,
  };
}
