import { defaultLocale } from './config.js';
import { parseFrontmatter } from './frontmatter.js';
import { readLandingPages } from './landings.js';
import { loadImprovements, slugsInCooldown, COOLDOWN_DAYS } from './improvements.js';
import { loadAlerts } from './watch.js';
import { loadIndexStatus, isIndexed } from './index-status.js';
import { addDays } from './measure.js';
import { format } from './date.js';

const trimSlash = u => String(u).replace(/\/+$/, '');

function pathOf(url, base) {
  const b = trimSlash(base);
  const u = trimSlash(String(url).split(/[?#]/)[0]);
  return u.startsWith(b) ? u.slice(b.length).replace(/^\/+/, '') : null;
}

/**
 * Default-locale landing pages with their `alternate:` counterpart slug (null without one).
 * The counterpart locale shares the bare URL space (counterpart_url_prefix may add a prefix).
 */
export function counterpartPairs(config, cwd = process.cwd()) {
  return readLandingPages(config, cwd, defaultLocale(config)).map((p) => {
    const alt = parseFrontmatter(p.markdown).parsed?.alternate;
    return { slug: p.slug, counterpart: typeof alt === 'string' && alt ? alt : null };
  });
}

/**
 * The default-locale slug an index alert URL belongs to: the page itself, or for a
 * counterpart URL the page whose `alternate:` names it (a rewrite re-adapts the counterpart).
 */
export function slugForUrl(url, config, pairs) {
  let path = pathOf(url, config.base_url);
  if (path === null) return null;
  const prefix = String(config.counterpart_url_prefix || '').replace(/^\/+|\/+$/g, '');
  if (prefix && path.startsWith(`${prefix}/`)) {
    path = path.slice(prefix.length + 1);
    return pairs.find(p => p.counterpart === path)?.slug ?? null;
  }
  if (pairs.some(p => p.slug === path)) return path;
  return pairs.find(p => p.counterpart === path)?.slug ?? null;
}

/**
 * An open `deindexed` or `site_not_indexed` alert whose live fetch was clean and that has a
 * content assessment gets the assessment carried out as a rewrite: no to-do for the owner. A
 * `deindexed` alert names one page; a `site_not_indexed` alert names the URLs it diagnosed, and
 * the first of them that qualifies is rewritten (one page per pick, the next one next time).
 * The page must exist, sit outside the improve cooldown, `exclude_slugs` and `skip` (pages
 * another PR of the same run touches), and must not have been rewritten since the assessment.
 * Pages someone else writes (`content_owner`) are left to them. Oldest assessment first.
 * Returns `{ slug, alert_id, assessment }` or null.
 */
export function pickAssessedPage({ config, cwd = process.cwd(), today = new Date(), improvements = loadImprovements(cwd), alerts = loadAlerts(cwd, []), skip = [] }) {
  const pairs = counterpartPairs(config, cwd);
  const blocked = new Set([...slugsInCooldown(improvements, today), ...(config.exclude_slugs || []), ...skip]);
  const candidates = (alerts.open || [])
    .filter(a => ASSESSED_KINDS.has(a.kind) && a.diagnosis?.cause === 'clean' && a.assessment?.actions?.length && !a.assessment.content_owner)
    .sort((a, b) => String(a.assessment.assessed_at).localeCompare(String(b.assessment.assessed_at)));
  for (const alert of candidates) {
    for (const url of alertUrls(alert)) {
      const slug = slugForUrl(url, config, pairs);
      if (!slug || blocked.has(slug)) continue;
      const rewrittenSince = (improvements.entries || []).some(e => e.slug === slug && !e.failed && e.date >= alert.assessment.assessed_at);
      if (rewrittenSince) continue;
      // A rewrite already did not help and the assessment names the sibling it duplicates: that is a merge (pickMergePage).
      if (alert.assessment.merge_into && (alert.assessment.merge_proposed_at || rewrittenBefore(improvements, slug, alert.assessment.assessed_at))) continue;
      return { slug, alert_id: alert.id, assessment: alert.assessment };
    }
  }
  return null;
}

// A merged rewrite of the page from before the given day.
function rewrittenBefore(improvements, slug, day) {
  return (improvements.entries || []).some(e => e.slug === slug && !e.failed && e.merged_at && e.date < day);
}

const ASSESSED_KINDS = new Set(['deindexed', 'site_not_indexed']);

// The page URLs an alert stands for: the diagnosed URLs, else the URL in a `deindexed:<url>` id.
function alertUrls(alert) {
  const diagnosed = (alert.diagnosis?.urls || []).map(u => u?.url).filter(Boolean);
  if (diagnosed.length) return diagnosed;
  const fromId = alert.id.slice(alert.id.indexOf(':') + 1);
  return /^https?:\/\//.test(fromId) ? [fromId] : [];
}

/**
 * A page Google still skips after a rewrite, whose newer assessment names an indexed sibling it
 * duplicates (`merge_into`), is proposed for a merge into that sibling: one PR that rewrites the
 * sibling with what is worth keeping, deletes the page and redirects it. The PR opens as a draft
 * and waits for the owner (deleting and redirecting a live page is the owner's call); each
 * assessment proposes at most once (`merge_proposed_at`). Both pages must exist, neither may be
 * in `exclude_slugs` or `skip`, the sibling must be indexed and outside the improve cooldown, and
 * the page must have had a merged rewrite before the assessment. Oldest assessment first.
 * Returns `{ slug, from, alert_id }` (slug = the page that stays) or null.
 */
export function pickMergePage({ config, cwd = process.cwd(), today = new Date(), improvements = loadImprovements(cwd), alerts = loadAlerts(cwd, []), entries = loadIndexStatus(cwd).entries, skip = [] }) {
  const pairs = counterpartPairs(config, cwd);
  const excluded = new Set([...(config.exclude_slugs || []), ...skip]);
  const cooldown = new Set(slugsInCooldown(improvements, today));
  const indexed = new Set((entries || []).filter(e => isIndexed(e)).map(e => trimSlash(e.url)));
  const candidates = (alerts.open || [])
    .filter(a => a.kind === 'deindexed' && a.diagnosis?.cause === 'clean' && a.assessment?.merge_into && !a.assessment.content_owner && !a.assessment.merge_proposed_at)
    .sort((a, b) => String(a.assessment.assessed_at).localeCompare(String(b.assessment.assessed_at)));
  for (const alert of candidates) {
    const from = alertUrls(alert).map(u => slugForUrl(u, config, pairs)).find(Boolean);
    const into = alert.assessment.merge_into;
    if (!from || from === into || excluded.has(from) || excluded.has(into) || cooldown.has(into)) continue;
    if (!pairs.some(p => p.slug === into) || !indexed.has(`${trimSlash(config.base_url)}/${into}`)) continue;
    if (!rewrittenBefore(improvements, from, alert.assessment.assessed_at)) continue;
    return { slug: into, from, alert_id: alert.id };
  }
  return null;
}

/** Diagnosis text for the improve prompt: the assessment's causes and actions as the brief. */
export function assessmentDiagnosis(assessment) {
  return [
    'Google crawled this page but does not show it in search, although it is technically fine (status 200, no noindex, self canonical).',
    'A content assessment named the likely reasons and what would help. Carry these out in this page\'s own text.',
    'Anything that concerns another page (merging, redirecting, editing a sibling) is not part of this rewrite: instead trim this page where it repeats a sibling.',
    'A figure without a source (percentages, rates, counts) is removed or turned into a qualitative statement, never kept unsourced and never invented anew.',
    '',
    'Likely reasons:',
    ...(assessment.likely_causes || []).map(c => `- ${c}`),
    '',
    'What would help:',
    ...(assessment.actions || []).map(a => `- ${a.action}${a.why ? ` (${a.why})` : ''}`),
  ].join('\n');
}

/**
 * What happens with each assessment of this run, for the mail: `rewritten` (with the PR),
 * `owner` (someone else writes the page), `site` (site-wide alert), `unmapped` (URL is no landing
 * page), or `scheduled` with the first day the page can be
 * rewritten (the improve cooldown). Mutates and returns `assessments`.
 */
export function annotateFollowups({ assessments = [], config, cwd = process.cwd(), prs = [], today = format(new Date()), improvements = loadImprovements(cwd) }) {
  let pairs = null;
  for (const s of assessments) {
    if (s.content_owner) { s.followup = { status: 'owner' }; continue; }
    // A rewrite this run carried out for the alert itself (also one page of a site-wide alert).
    const proposed = prs.find(p => p.kind === 'merge' && p.assessed === s.alert_id);
    if (proposed) { s.followup = { status: 'merge_proposed', slug: proposed.slug, from: proposed.from, pr_url: proposed.url }; continue; }
    const carried = prs.find(p => p.kind === 'improve' && p.assessed === s.alert_id);
    if (carried) { s.followup = { status: 'rewritten', slug: carried.slug, pr_url: carried.url }; continue; }
    const url = s.alert_id.includes(':') ? s.alert_id.slice(s.alert_id.indexOf(':') + 1) : '';
    // A site-wide alert with no page rewritten this run: its pages come up one per run.
    if (!/^https?:\/\//.test(url)) { s.followup = { status: 'site' }; continue; }
    pairs ??= counterpartPairs(config, cwd);
    const slug = slugForUrl(url, config, pairs);
    if (!slug) { s.followup = { status: 'unmapped' }; continue; }
    const pr = prs.find(p => p.kind === 'improve' && p.slug === slug);
    if (pr) { s.followup = { status: 'rewritten', slug, pr_url: pr.url }; continue; }
    const last = (improvements.entries || []).filter(e => e.slug === slug).map(e => e.date).sort().at(-1);
    const notBefore = last ? addDays(last, COOLDOWN_DAYS) : today;
    s.followup = { status: 'scheduled', slug, not_before: notBefore > today ? notBefore : today };
  }
  return assessments;
}
