import { addDays } from './measure.js';
import { defaultLocale, localeUrlPath } from './config.js';
import { isWaiting, trimSlash, REASSESS_AFTER_DAYS } from './recrawl.js';

// Pure rules of the action queue of `seo run`: rank, dedup, locks, brake, cap. The candidates come from
// steps/queue.js (the pickers), the execution lives in commands/run.js. No I/O.

// Lower runs first. Within a type the score decides (an assessed pick beats a GSC pick).
export const TYPE_RANK = { revert: 1, merge: 2, prune: 2, refresh: 3, rewrite: 4, snippet_test: 5, faq: 5, overlay: 6, new_page: 7 };

// The page work that keeps one reserved slot, so rewrites and reverts cannot starve it.
export const AUTO_TYPES = new Set(['snippet_test', 'faq', 'new_page', 'overlay']);

// Only these open as a draft and wait for the owner: they delete and redirect live pages. Every other type
// (rewrite, refresh, revert, ...) merges through the gate by itself (owner decision 2026-11-26: every seo-cli
// PR goes live on its own, only removing live pages needs an okay).
export const DRAFT_TYPES = new Set(['merge', 'prune']);

export const MAX_HELD_DRAFTS = 3;
export const DRAFT_WARN_DAYS = 14;
const BRAKE_MIN_DAYS = 7;
const BRAKE_MAX_DAYS = 35;
const BRAKE_MAX_AGE_DAYS = 56;
const BRAKED_TYPES = new Set(['new_page', 'snippet_test', 'faq', 'refresh']);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole days from one YYYY-MM-DD day to another. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const rankOf = (c) => TYPE_RANK[c.type] ?? 99;

/**
 * Result shape shared by the pickers: without `limit` the first pick or null (the old call style), with
 * `limit` an array of at most that many picks.
 */
export const takePicks = (picks, limit) => (limit === undefined ? (picks[0] ?? null) : picks.slice(0, limit));

/**
 * The emergency brake: an open `traffic_drop` alert that started 7 to 35 days after the newest change
 * of the ledger (no merge between that change and the alert) is blamed on our own work. It ends with
 * the alert, at the latest BRAKE_MAX_AGE_DAYS after it began. Returns `{ since, days, merge }`, or
 * `{ expired: true, since }` after the age limit, or null.
 */
export function trafficBrake({ alerts = [], changes = [], today }) {
  const drop = alerts.find(a => a.id === 'traffic_drop' || a.kind === 'traffic_drop');
  if (!drop?.since) return null;
  const merge = changes.map(e => e.merged_at).filter(m => m && m <= drop.since).sort().at(-1);
  if (!merge) return null;
  const gap = daysBetween(merge, drop.since);
  if (gap < BRAKE_MIN_DAYS || gap > BRAKE_MAX_DAYS) return null;
  const days = daysBetween(drop.since, today);
  if (days > BRAKE_MAX_AGE_DAYS) return { expired: true, since: drop.since };
  return { since: drop.since, days, merge };
}

// Pages a merged merge or removal PR pointed at in the last REASSESS_AFTER_DAYS days, with the merge day.
function recentTargets(improvements, today) {
  const out = [];
  for (const e of improvements.entries || []) {
    const target = e.merge ? e.slug : e.prune ? e.into : null;
    const day = e.merged_at?.slice(0, 10);
    if (target && day && day > addDays(today, -REASSESS_AFTER_DAYS)) out.push({ slug: target, day });
  }
  return out;
}

/** Text block at the top of a held draft: what the queue did and why. */
export function whyBlock({ type, source, why, score }) {
  return [
    '## Warum diese Aktion',
    '',
    `- Typ: ${type}`,
    `- Quelle: ${source}`,
    `- Begründung: ${why}`,
    ...(score !== undefined && score !== null ? [`- Score: ${Math.round(score * 100) / 100}`] : []),
    '',
    '',
  ].join('\n');
}

/**
 * Orders the candidates and decides which of them run: rank, dedup over `touches`, locks, brake, cap.
 * A candidate is `{ type, slug, source, why, score, touches: [slugs], ... }`. `executed` are entries that
 * already ran before the queue (the revert phase), each with its own `status` (`opened` counts against
 * the cap). Every returned entry carries `status` (`selected`, `opened`, `deferred`, `blocked`) and,
 * except for selected ones, a `reason`. One slot of the cap is kept for page work (new page, snippet
 * test, overlay). Returns `{ queue, warnings }`.
 */
export function buildQueue({ candidates, executed = [], config = {}, today, alerts = [], changes = [], improvements = { entries: [] }, indexEntries = [] }) {
  const warnings = [];
  const open = improvements.entries?.filter(e => e.pr_url && !e.merged_at && !e.closed_at) ?? [];
  const held = open.filter(e => e.held);
  const brake = trafficBrake({ alerts, changes, today });
  if (brake?.expired) warnings.push(`Traffic brake released: traffic_drop open since ${brake.since}, more than ${BRAKE_MAX_AGE_DAYS} days`);
  const braking = brake && !brake.expired ? brake : null;
  if (braking) warnings.push(`Traffic brake active for ${braking.days} day(s): traffic_drop since ${braking.since}, last merge ${braking.merge}. New pages, snippet tests, FAQ answers, refreshes and GSC rewrites are held`);
  if (config.paused) warnings.push('seo run is paused (paused: true): only reverts run');
  for (const e of held) {
    const age = daysBetween(e.date, today);
    if (age > DRAFT_WARN_DAYS) warnings.push(`Draft for ${e.slug} (${e.pr_url}) has waited ${age} days for approval`);
  }

  const siteNotIndexed = alerts.some(a => a.kind === 'site_not_indexed');
  const notDeployed = new Set(alerts.filter(a => String(a.id).startsWith('not_deployed:')).map(a => a.id.slice('not_deployed:'.length)));
  const openSlugs = new Set(open.map(e => e.slug));
  const targets = recentTargets(improvements, today);
  const base = trimSlash(config.base_url || '');
  const locale = defaultLocale(config);
  const waitingForCrawl = (slug) => targets.some(t => t.slug === slug
    && isWaiting({ diagnosis: { urls: [{ url: `${base}${localeUrlPath(config, slug, locale)}` }] } }, t.day, indexEntries, today));

  const blockedReason = (c) => {
    if (config.paused) return 'paused';
    if (braking && (BRAKED_TYPES.has(c.type) || (c.type === 'rewrite' && c.source === 'gsc'))) return 'brake';
    if (siteNotIndexed && c.type === 'new_page') return 'site_not_indexed';
    if (c.touches.some(t => notDeployed.has(t))) return 'not_deployed';
    if (['rewrite', 'snippet_test', 'faq'].includes(c.type) && waitingForCrawl(c.slug)) return 'recrawl';
    if (c.slug && openSlugs.has(c.slug)) return 'open_pr';
    return null;
  };

  const ordered = candidates
    .map(c => ({ touches: [], ...c }))
    .sort((a, b) => rankOf(a) - rankOf(b) || (b.source === 'alert') - (a.source === 'alert') || (b.score ?? 0) - (a.score ?? 0));

  const taken = new Set();
  const results = [];
  const eligible = [];
  let draftsSelected = 0;
  for (const c of ordered) {
    const blocked = blockedReason(c);
    if (blocked) { results.push({ ...c, status: 'blocked', reason: blocked }); continue; }
    const draft = DRAFT_TYPES.has(c.type);
    if (draft && held.length + draftsSelected >= MAX_HELD_DRAFTS) { results.push({ ...c, status: 'deferred', reason: 'drafts_waiting' }); continue; }
    if (c.touches.some(t => taken.has(t))) { results.push({ ...c, status: 'deferred', reason: 'overlap' }); continue; }
    if (draft) draftsSelected++;
    c.touches.forEach(t => taken.add(t));
    const entry = { ...c, status: 'selected', reason: null };
    results.push(entry);
    eligible.push(entry);
  }

  const used = executed.filter(e => e.status === 'opened').length;
  const room = Math.max(0, (config.max_prs_per_run ?? 4) - used);
  const reserved = eligible.find(c => AUTO_TYPES.has(c.type));
  const chosen = new Set(reserved && room > 0 ? [reserved] : []);
  for (const c of eligible) if (chosen.size < room) chosen.add(c);
  for (const c of eligible) if (!chosen.has(c)) { c.status = 'deferred'; c.reason = 'cap'; }

  return { queue: [...executed, ...results], warnings };
}

/**
 * The next entries to run when an earlier one produced nothing: those deferred only by the cap, in rank
 * order. `room` is what is still free below the cap.
 */
export function nextInLine(queue, room) {
  return room > 0 ? queue.filter(e => e.status === 'deferred' && e.reason === 'cap' && e.type !== 'revert').slice(0, room) : [];
}

/** What a ledger entry remembers about the decision, for the later look back (Etappe F). */
export const predictedOf = ({ type, score, why }) => ({ type, score: score ?? null, basis: why });
