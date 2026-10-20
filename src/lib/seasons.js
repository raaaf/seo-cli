import chalk from 'chalk';
import { format } from './date.js';
import { getExistingSlugs } from './landings.js';
import { defaultLocale } from './config.js';
import { loadImprovements, slugsInCooldown } from './improvements.js';

export const DEFAULT_LEAD_WEEKS = 10;

// A page rewritten for a season stays off the seasonal list for most of a year,
// so the same page is not refreshed twice in one cycle (the normal cooldown is 56 days).
export const SEASON_REFRESH_DAYS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

const strings = (value) => (Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))] : []);

// UTC midnight of `year`-`month`-`day`, or null when that date does not exist (02-30, 02-29 in a common year).
function utcDate(year, month, day) {
  const time = Date.UTC(year, month - 1, day);
  const d = new Date(time);
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? time : null;
}

// The next occurrence of MM-DD on or after `todayTime`, or null for a malformed peak.
function nextPeak(peak, todayTime) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(peak));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (utcDate(2000, month, day) === null) return null;
  const year = new Date(todayTime).getUTCFullYear();
  for (let y = year; y <= year + 4; y++) {
    const time = utcDate(y, month, day);
    if (time !== null && time >= todayTime) return time;
  }
  return null;
}

/**
 * Seasons whose lead window contains `today`: from `lead_weeks` weeks before the
 * nearest upcoming peak until the peak day itself. Sorted nearest peak first,
 * each with the resolved peak as YYYY-MM-DD. Malformed entries are skipped with a warning.
 */
export function activeSeasons(seasons, today = new Date()) {
  if (!Array.isArray(seasons)) return [];
  const todayTime = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const active = [];
  for (const [i, season] of seasons.entries()) {
    const name = typeof season?.name === 'string' ? season.name.trim() : '';
    const lead = season?.lead_weeks ?? DEFAULT_LEAD_WEEKS;
    const peakTime = name ? nextPeak(season.peak, todayTime) : null;
    if (!name || peakTime === null || !(Number.isFinite(lead) && lead > 0)) {
      console.warn(chalk.yellow(`  Season #${i + 1} (${name || 'no name'}) ignored: needs a name, peak as MM-DD and a positive lead_weeks`));
      continue;
    }
    if (todayTime < peakTime - lead * 7 * DAY_MS) continue;
    active.push({ name, peak: format(new Date(peakTime)), lead_weeks: lead, keywords: strings(season.keywords), pages: strings(season.pages) });
  }
  return active.sort((a, b) => a.peak.localeCompare(b.peak));
}

/**
 * The page the improve step rewrites ahead of a season, or null. Pages listed under
 * active seasons that exist, are not excluded, are outside the normal cooldown and
 * were not rewritten in the last SEASON_REFRESH_DAYS days. Nearest peak first,
 * listed order within a season.
 */
export function pickSeasonPage({ config, cwd = process.cwd(), today = new Date(), improvements = loadImprovements(cwd) }) {
  const known = new Set(getExistingSlugs(config, cwd, defaultLocale(config)));
  const blocked = new Set([
    ...slugsInCooldown(improvements, today),
    // A failed attempt (no PR) holds the page off for the normal cooldown only, it was never refreshed.
    ...slugsInCooldown({ entries: (improvements.entries || []).filter(e => !e.failed) }, today, SEASON_REFRESH_DAYS),
    ...(config.exclude_slugs || []),
  ]);
  for (const season of activeSeasons(config.seasons, today)) {
    const slug = season.pages.find(s => known.has(s) && !blocked.has(s));
    if (slug) return { slug, season: season.name, peak: season.peak };
  }
  return null;
}
