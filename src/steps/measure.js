import chalk from 'chalk';
import { defaultLocale } from '../lib/config.js';
import { getExistingSlugs } from '../lib/landings.js';
import { loadChanges, saveChanges } from '../lib/changes.js';
import { queryPageTotals } from '../lib/gsc.js';
import { format } from '../lib/date.js';
import {
  windowsFor, isDue, normalizeUrl, urlToSlug, aggregatePages, sumMetrics, selectControls,
  verdictFor, isOverlap, isRevertCandidate,
} from '../lib/measure.js';

const READINGS = ['d28', 'd56'];
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
  const slugsByLocale = { [def]: getExistingSlugs(config, cwd, def) };
  if (config.counterpart_locale && config.counterpart_locale !== def) {
    slugsByLocale[config.counterpart_locale] = getExistingSlugs(config, cwd, config.counterpart_locale);
  }

  // Known landing pages with their totals in one window. A window without a single
  // impression means a wrong property or an outage, never a measurement.
  async function windowPages(window) {
    const rows = await queryPageTotals(config.gsc_property, { ...window, pageFilter: config.base_url || null });
    const pages = new Map();
    for (const [url, totals] of aggregatePages(rows)) {
      const page = urlToSlug(url, config, slugsByLocale);
      if (page) pages.set(url, { ...page, ...totals });
    }
    if (![...pages.values()].some(p => p.impressions > 0)) {
      throw new Error(`GSC returned no landing page impressions for ${window.startDate} to ${window.endDate}`);
    }
    return pages;
  }

  async function measureEntry(entry, key) {
    const windows = windowsFor(entry.merged_at);
    const window = windows[key];
    const reading = { measured_at: today, window };

    if (entry.kind === 'new') {
      const pages = await windowPages(window);
      return { ...reading, ...sumMetrics(entry.urls.map(u => pages.get(normalizeUrl(u)) ?? NONE)) };
    }

    if (isOverlap(entry, changes.entries, { startDate: windows.baseline.startDate, endDate: window.endDate })) {
      return { ...reading, verdict: 'insufficient_data', reason: 'overlap' };
    }
    const baselinePages = await windowPages(windows.baseline);
    const afterPages = await windowPages(window);
    const target = normalizeUrl(entry.urls[0]);
    entry.baseline ??= { window: windows.baseline, ...(baselinePages.get(target) ?? NONE) };
    const after = afterPages.get(target) ?? NONE;

    // Pages touched near this one, counterparts included, are no control.
    const touched = new Set(changes.entries
      .filter(e => e.merged_at >= windows.baseline.startDate && e.merged_at <= windows.d56.endDate)
      .flatMap(e => e.urls.map(normalizeUrl)));
    const candidates = [...baselinePages]
      .filter(([url, page]) => page.locale === def && !touched.has(url))
      .map(([url, page]) => ({ key: url, impressions: page.impressions }));
    const controls = selectControls(entry.baseline.impressions, candidates)
      .map(c => ({ before: baselinePages.get(c.key), after: afterPages.get(c.key) ?? NONE }));

    return { ...reading, ...after, ...verdictFor({ target: { before: entry.baseline, after }, controls }) };
  }

  let due = 0;
  let dirty = false;
  const changed = [];
  for (const entry of changes.entries) {
    const windows = windowsFor(entry.merged_at);
    for (const key of READINGS) {
      if (entry.readings[key] || !isDue(windows[key], today)) continue;
      due++;
      try {
        entry.readings[key] = await measureEntry(entry, key);
        dirty = true;
        changed.push({ slug: entry.slug, kind: entry.kind, reading: key, verdict: entry.readings[key].verdict ?? null });
      } catch (e) {
        warnings.push(`Measurement of ${entry.slug} (${key}) failed: ${e.message}`);
      }
    }
    if (entry.kind === 'rewrite' && !entry.revert_candidate && isRevertCandidate(entry)) {
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
    insufficient_by_reason: tally('reason', ['volume', 'control', 'dispersion', 'overlap']),
    revert_candidates: changes.entries.filter(e => e.revert_candidate).map(e => e.slug),
    changed,
  };
}
