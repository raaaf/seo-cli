// Rybbit adapter: raw API answers live in the signal store (7 days), the pure part turns them
// into per-landing-page stats. "Einstiege" are sessions that begin on the page (`entry_page` count).
// A goal that could not be measured is `null`, never 0: a renamed goal, a failed call and a goal
// that fired nowhere on the site in the window all read the same as "not measured".

import { defaultLocale } from '../config.js';
import { format } from '../date.js';
import { addDays, normalizeUrl, urlToSlug } from '../measure.js';
import { getExistingSlugs } from '../landings.js';
import { entryPages, aiEntryPages, aiSources, goalsForEntry } from '../rybbit.js';
import { getFresh, putSignal } from './store.js';

export const RYBBIT_SIGNALS_NAME = 'rybbit';
const TTL_DAYS = 7;
// Goal queries cost one call per page: the pages of the report plus the pages `improve` may boost.
const GOAL_TOP_PAGES = 10;
export const GOAL_MIN_ENTRIES = 30;
const MAX_SOURCES = 8;

/** Whether Rybbit is configured completely and has a key. A half-configured or keyless setup warns once. */
export function rybbitActive(config, warnings = []) {
  const r = config.rybbit;
  if (!r?.enabled) return false;
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  if (!r.url || !r.site_id || !r.macro_goal) {
    warn('rybbit.enabled is set but url, site_id or macro_goal is missing, skipping Rybbit');
    return false;
  }
  if (!process.env.RYBBIT_API_KEY) {
    warn('rybbit.enabled is set but RYBBIT_API_KEY is missing, skipping Rybbit');
    return false;
  }
  return true;
}

/** Landing page slugs per locale (default and counterpart), as `urlToSlug` expects them. */
export function landingSlugs(config, cwd) {
  const def = defaultLocale(config);
  const slugs = { [def]: getExistingSlugs(config, cwd, def) };
  if (config.counterpart_locale && config.counterpart_locale !== def) {
    slugs[config.counterpart_locale] = getExistingSlugs(config, cwd, config.counterpart_locale);
  }
  return slugs;
}

/** The last 4 complete weeks (28 days, Monday to Sunday) before `today` (YYYY-MM-DD); the end date stays the same for a whole week. */
export function fourWeekWindow(today) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const endDate = addDays(today, -(dow === 0 ? 7 : dow));
  return { startDate: addDays(endDate, -27), endDate };
}

const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

// Entry rows of one page (all path variants) into one group; averages are weighted by entries.
function groupPages(rows, config, slugsByLocale) {
  const base = String(config.base_url || '').replace(/\/+$/, '');
  const groups = new Map();
  for (const row of rows) {
    if (!row.value.startsWith('/')) continue;
    const page = urlToSlug(base + row.value, config, slugsByLocale);
    if (!page) continue;
    const key = `${page.locale}:${page.slug}`;
    const g = groups.get(key) ?? { key, slug: page.slug, locale: page.locale, url: normalizeUrl(base + row.value), paths: [], entries: 0, bounce: [0, 0], time: [0, 0] };
    g.paths.push(row.value);
    g.entries += row.count;
    if (row.bounce_rate !== null) { g.bounce[0] += row.bounce_rate * row.count; g.bounce[1] += row.count; }
    if (row.time_on_page_seconds !== null) { g.time[0] += row.time_on_page_seconds * row.count; g.time[1] += row.count; }
    groups.set(key, g);
  }
  return groups;
}

// Conversions of one goal for one page, or null when the number cannot be trusted:
// no answer, goal unknown (renamed, deleted) or without a single conversion site-wide.
function goalCount(name, pageGoals, siteGoals) {
  const own = pageGoals?.find(g => g.name === name);
  const site = siteGoals?.find(g => g.name === name);
  if (!own || !site || own.total_conversions === null || !site.total_conversions) return null;
  return own.total_conversions;
}

const sumOrNull = (values) => (values.some(v => v === null) ? null : values.reduce((a, b) => a + b, 0));

// Max per value of two lists: a session can match both the referrer and the utm_source filter.
function maxByValue(a, b) {
  const out = new Map();
  for (const row of [...(a ?? []), ...(b ?? [])]) out.set(row.value, Math.max(out.get(row.value) ?? 0, row.count));
  return out;
}

/**
 * Raw answers into per-page stats. `raw`: `{ entry, ai_referrer, ai_utm, ai_src_referrer, ai_src_utm,
 * goals_all, goals: { [pageKey]: [...] } }`, any part may be missing (null). Pages are grouped over
 * `urlToSlug` (path variants, query and locale folded together), most entries first. `macro` and
 * `micro` are `null` unless goals were measured for the page; `micro` is `null` as soon as one
 * micro goal is, and 0 when the project names none.
 */
export function pageStats(raw, config, slugsByLocale) {
  const { macro_goal: macroGoal, micro_goals: microGoals = [] } = config.rybbit;
  const groups = groupPages(raw.entry ?? [], config, slugsByLocale);
  const ai = maxByValue(raw.ai_referrer, raw.ai_utm);
  const aiRows = [...ai].map(([value, count]) => ({ value, count, bounce_rate: null, time_on_page_seconds: null }));
  const aiByPage = groupPages(aiRows, config, slugsByLocale);

  const pages = [...groups.values()].map((g) => {
    const goals = raw.goals?.[g.key] ?? null;
    return {
      key: g.key, slug: g.slug, locale: g.locale, url: g.url,
      entries: g.entries,
      bounce_rate: g.bounce[1] ? round(g.bounce[0] / g.bounce[1]) : null,
      time_on_page: g.time[1] ? Math.round(g.time[0] / g.time[1]) : null,
      ai_entries: aiByPage.get(g.key)?.entries ?? 0,
      macro: goalCount(macroGoal, goals, raw.goals_all ?? null),
      micro: sumOrNull(microGoals.map(name => goalCount(name, goals, raw.goals_all ?? null))),
    };
  }).sort((a, b) => b.entries - a.entries);

  const sources = [...maxByValue(raw.ai_src_referrer, raw.ai_src_utm)]
    .map(([source, entries]) => ({ source, entries }))
    .sort((a, b) => b.entries - a.entries)
    .slice(0, MAX_SOURCES);
  const known = (name) => raw.goals_all?.some(g => g.name === name);
  return {
    totals: {
      entries: (raw.entry ?? []).reduce((sum, r) => sum + r.count, 0),
      landing_entries: pages.reduce((sum, p) => sum + p.entries, 0),
      ai_entries: [...ai.values()].reduce((a, b) => a + b, 0),
    },
    ai_sources: raw.ai_src_referrer || raw.ai_src_utm ? sources : null,
    pages,
    missing_goals: raw.goals_all ? [macroGoal, ...microGoals].filter(name => !known(name)) : [],
  };
}

/** Stats of the given pages together (one change in the ledger): sums, entry-weighted bounce and time, `null` goals stay `null`. */
export function readingStats(pages, keys) {
  const own = pages.filter(p => keys.has(p.key));
  const weighted = (field) => {
    const rows = own.filter(p => p[field] !== null);
    const weight = rows.reduce((sum, p) => sum + p.entries, 0);
    return weight ? rows.reduce((sum, p) => sum + p[field] * p.entries, 0) / weight : null;
  };
  const bounce = weighted('bounce_rate');
  const time = weighted('time_on_page');
  return {
    entries: own.reduce((sum, p) => sum + p.entries, 0),
    bounce_rate: bounce === null ? null : round(bounce),
    time_on_page: time === null ? null : Math.round(time),
    ai_entries: own.reduce((sum, p) => sum + p.ai_entries, 0),
    macro: own.length ? sumOrNull(own.map(p => p.macro)) : null,
    micro: own.length ? sumOrNull(own.map(p => p.micro)) : null,
  };
}

/**
 * Rybbit stats of a window. Raw answers come from the signal store when fresh (key
 * `<site>:<endDate>:<kind>`, the kind carries the start date because readings use other windows
 * than the weekly one) and are fetched otherwise; a dry run reads the cache but writes nothing.
 * Goals are queried for the top 10 pages and every page with 30+ entries, or for `goalKeys`.
 * Returns `{ window, ...pageStats }`, or `{ error: kind }` when the entry pages are unavailable.
 * A failing optional part is a warning and reads as `null`. Never throws.
 */
export async function getRybbitStats({ config, cwd, window, slugsByLocale, warnings = [], dryRun = false, now = new Date(), goalKeys = null, sources = true }) {
  const site = config.rybbit.site_id;
  const cached = async (kind, fetcher) => {
    const key = `${site}:${window.endDate}:${kind}:${window.startDate}`;
    const hit = getFresh(RYBBIT_SIGNALS_NAME, key, TTL_DAYS, now, { cwd, validate: Array.isArray });
    if (hit) return hit;
    const value = await fetcher();
    if (!dryRun) putSignal(RYBBIT_SIGNALS_NAME, key, value, now, { cwd, ttlDays: TTL_DAYS });
    return value;
  };
  const optional = async (kind, fetcher) => {
    try {
      return await cached(kind, fetcher);
    } catch (e) {
      warnings.push(`Rybbit ${kind} unavailable: ${e.message}`);
      return null;
    }
  };

  const raw = {};
  try {
    raw.entry = await cached('entry', () => entryPages(config, window));
  } catch (e) {
    warnings.push(`Rybbit unavailable: ${e.message}`);
    return { error: e.kind ?? 'error' };
  }
  raw.ai_referrer = await optional('ai_referrer', () => aiEntryPages(config, window, 'referrer'));
  raw.ai_utm = await optional('ai_utm', () => aiEntryPages(config, window, 'utm_source'));
  if (sources) {
    raw.ai_src_referrer = await optional('ai_src_referrer', () => aiSources(config, window, 'referrer'));
    raw.ai_src_utm = await optional('ai_src_utm', () => aiSources(config, window, 'utm_source'));
  }
  raw.goals_all = await optional('goals_all', () => goalsForEntry(config, window));

  const groups = [...groupPages(raw.entry, config, slugsByLocale).values()].sort((a, b) => b.entries - a.entries);
  const wanted = raw.goals_all
    ? groups.filter((g, i) => (goalKeys ? goalKeys.has(g.key) : i < GOAL_TOP_PAGES || g.entries >= GOAL_MIN_ENTRIES))
    : [];
  raw.goals = {};
  for (const g of wanted) raw.goals[g.key] = await optional(`goals:${g.key}`, () => goalsForEntry(config, window, g.paths));

  const stats = pageStats(raw, config, slugsByLocale);
  const missing = `Rybbit goal(s) not found: ${stats.missing_goals.join(', ')}`;
  if (stats.missing_goals.length && !warnings.includes(missing)) warnings.push(missing);
  return { window, ...stats };
}

const REPORT_PAGES = 10;
export const REPORT_MIN_ENTRIES = 5;

/**
 * The `report.rybbit` section of `seo run`: the weekly window, totals, AI sources, the top 10 pages
 * with at least 5 entries and the goals that were not found. Without data: `{ error: <kind> }`, which
 * the mail shows as a task. Also returns all `pages` of the window for the assessment.
 */
export async function rybbitReport({ config, cwd, dryRun = false, warnings = [], today = format(new Date()) }) {
  const window = fourWeekWindow(today);
  const stats = await getRybbitStats({ config, cwd, window, slugsByLocale: landingSlugs(config, cwd), warnings, dryRun });
  if (stats.error) {
    warnings.push(`Rybbit delivers no data (${stats.error}): check the key`);
    return { report: { error: stats.error }, pages: [] };
  }
  const { totals, ai_sources, pages, missing_goals } = stats;
  const top = pages.filter(p => p.entries >= REPORT_MIN_ENTRIES).slice(0, REPORT_PAGES);
  return { report: { window, totals, ai_sources, pages: top, missing_goals }, pages };
}
