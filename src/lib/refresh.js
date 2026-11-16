import { defaultLocale } from './config.js';
import { parseFrontmatter } from './frontmatter.js';
import { readLandingPages } from './landings.js';
import { loadImprovements } from './improvements.js';
import { refreshBlocked } from './seasons.js';
import { takePicks } from './queue.js';
import { addDays } from './measure.js';

// A page whose `updated` date is older than this is stale whatever its text says.
export const STALE_UPDATED_DAYS = 365;

// A year after "seit", "ab" or "bis" (also "seit Januar 2025", "ab 1. Januar 2025") names a date, not the state of the page.
const BOUND_BEFORE_YEAR = /\b(seit|ab|bis)\b(?:[^.,;:!?]|\d\.){0,25}$/i;
// 2026, 2026/27, 2026/2027, 2026-27
const YEAR = /\b(20\d{2})(?:\s?[/–-]\s?((?:20)?\d{2}))?\b/g;

/**
 * The highest year a text states as the state of things, or null. Years bound by "seit", "ab" or "bis"
 * do not count. A span such as "2026/27" counts as its end year, and only once that year is over.
 */
export function highestYear(text, currentYear) {
  let best = null;
  for (const m of String(text ?? '').matchAll(YEAR)) {
    if (BOUND_BEFORE_YEAR.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    let year = Number(m[1]);
    if (m[2]) {
      const end = m[2].length === 2 ? Math.floor(year / 100) * 100 + Number(m[2]) : Number(m[2]);
      if (end > year && end - year <= 1) {
        if (end >= currentYear) continue;
        year = end;
      }
    }
    if (best === null || year > best) best = year;
  }
  return best;
}

// `updated:` as YYYY-MM-DD (an unquoted date is a Date for the YAML parser), null when missing or odd.
function updatedDay(parsed) {
  const raw = parsed?.updated instanceof Date ? parsed.updated.toISOString() : parsed?.updated;
  const day = typeof raw === 'string' ? raw.slice(0, 10) : null;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Why a page is stale, or null. Stale: the highest year in the meta title, meta description or H1 is
 * below the current year, or `updated` is older than STALE_UPDATED_DAYS days.
 */
export function staleReason(markdown, today) {
  const currentYear = Number(today.slice(0, 4));
  const { parsed, body } = parseFrontmatter(markdown);
  const h1 = parsed?.hero?.headline ?? /^#\s+(.+)$/m.exec(body ?? '')?.[1];
  const year = highestYear([parsed?.meta_title, parsed?.meta_description, h1].filter(Boolean).join(' | '), currentYear);
  if (year !== null && year < currentYear) return `title, description or headline still say ${year}`;
  const updated = updatedDay(parsed);
  if (updated && updated <= addDays(today, -STALE_UPDATED_DAYS)) return `last updated ${updated}, more than ${STALE_UPDATED_DAYS} days ago`;
  return null;
}

/**
 * Stale landing pages of the default locale that may be refreshed: outside the cooldown, `exclude_slugs`
 * and `skip`, and not successfully rewritten in the last 300 days (the rule of the seasonal refresh).
 * Oldest `updated` first. `limit` as in `takePicks`. Each pick is `{ slug, reason }`.
 */
export function pickStalePage({ config, cwd = process.cwd(), today = new Date(), improvements = loadImprovements(cwd), skip = [], limit }) {
  const day = today.toISOString().slice(0, 10);
  const blocked = new Set([...refreshBlocked({ config, improvements, today }), ...skip]);
  const stale = readLandingPages(config, cwd, defaultLocale(config))
    .filter(p => !blocked.has(p.slug))
    .map(p => ({ slug: p.slug, reason: staleReason(p.markdown, day), updated: updatedDay(parseFrontmatter(p.markdown).parsed) ?? '' }))
    .filter(p => p.reason)
    .sort((a, b) => a.updated.localeCompare(b.updated) || a.slug.localeCompare(b.slug));
  return takePicks(stale.map(({ slug, reason }) => ({ slug, reason })), limit);
}
