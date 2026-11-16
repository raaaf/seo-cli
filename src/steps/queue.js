import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';
import { defaultLocale } from '../lib/config.js';
import { format } from '../lib/date.js';
import { QUEUE_FILE } from '../lib/keywords.js';
import { loadImprovements, slugsInCooldown, parseOverlayKey } from '../lib/improvements.js';
import { MIN_TARGET_IMPRESSIONS } from '../lib/measure.js';
import { pickSeasonPage } from '../lib/seasons.js';
import { pickStalePage } from '../lib/refresh.js';
import { pickAssessedPage, pickMergePage, pickPrunePage, counterpartPairs } from '../lib/assessed-rewrite.js';
import { fetchPagePerformance, selectPage } from './improve.js';

/**
 * Gathers the candidates of one `seo run` from every source, each picker asked for one pick (`limit: 1`)
 * and told which slugs the earlier ones already take (`skip`). Nothing is ranked or limited here, that is
 * `buildQueue`. A candidate is `{ type, slug, source, why, score, touches, pick }`: `touches` are all the
 * slugs its PR writes (page, counterpart, merge source or target), `pick` is what `prepareImprove` takes.
 *
 * `toGenerate` are the keywords due for a new page. The Search Console pick, snippet tests and overlays
 * come only in a week that generates no page (an empty backlog is the normal state once the topics are
 * covered). `fetchRows` is injectable for tests.
 */
export async function collectCandidates({ config, cwd = process.cwd(), today = new Date(), catalogDown = false, toGenerate = [], engagement = null, warnings = [], fetchRows = fetchPagePerformance }) {
  const improvements = loadImprovements(cwd);
  const pairs = counterpartPairs(config, cwd);
  const out = [];
  const claimed = [];
  const counterpartOf = (slug) => pairs.find(p => p.slug === slug)?.counterpart;
  const add = (candidate, ...slugs) => {
    const touches = [...new Set(slugs.filter(Boolean).flatMap(s => [s, counterpartOf(s)]).filter(Boolean))];
    claimed.push(...touches);
    out.push({ score: 0, ...candidate, touches });
  };

  if (!catalogDown && config.merge_proposals !== false) {
    for (const m of pickMergePage({ config, cwd, today, improvements, skip: claimed, limit: 1 })) {
      add({ type: 'merge', slug: m.slug, source: 'alert', why: `Index assessment: /${m.from} duplicates /${m.slug}, which Google shows`, pick: m }, m.slug, m.from);
    }
  }
  if (!catalogDown && config.prune_proposals !== false) {
    for (const p of pickPrunePage({ config, cwd, today, improvements, skip: claimed, limit: 1 })) {
      add({ type: 'prune', slug: p.slug, source: 'alert', why: `Google still skips /${p.slug} after two rewrites, /${p.into} is indexed`, pick: p }, p.slug, p.into);
    }
  }
  for (const s of pickSeasonPage({ config, cwd, today, improvements, skip: claimed, limit: 1 })) {
    add({ type: 'refresh', slug: s.slug, source: 'season', why: `Saison ${s.season}, Peak ${s.peak}`, pick: { kind: 'season', ...s } }, s.slug);
  }
  for (const s of pickStalePage({ config, cwd, today, improvements, skip: claimed, limit: 1 })) {
    add({ type: 'refresh', slug: s.slug, source: 'stale', why: s.reason, pick: { kind: 'stale', ...s } }, s.slug);
  }
  // The switch only keeps an assessed rewrite out of a run that already refreshes a page.
  if (!(config.assessed_rewrites === false && out.some(c => c.type === 'refresh'))) {
    for (const a of pickAssessedPage({ config, cwd, today, improvements, skip: claimed, limit: 1 })) {
      // A recipe page keeps its text in an overlay file: its rewrite is an overlay.
      add({ type: parseOverlayKey(a.slug) ? 'overlay' : 'rewrite', slug: a.slug, source: 'alert', why: `Index assessment of ${a.alert_id}: Google does not show the page`, pick: { kind: 'assessed', ...a } }, a.slug);
    }
  }

  if (toGenerate.length === 0) {
    let rows = null;
    try {
      rows = await fetchRows(config);
    } catch (e) {
      console.log(chalk.yellow(`  Search Console unavailable: ${e.message}`));
      warnings.push(`Search Console unavailable for the improve pick: ${e.message}`);
    }
    if (rows) {
      const [page] = selectPage({ rows, config, cwd, cooldown: slugsInCooldown(improvements), engagement, skip: claimed, limit: 1 });
      if (page) {
        const snippet = page.kind === 'snippet' && page.impressions >= MIN_TARGET_IMPRESSIONS;
        add({ type: snippet ? 'snippet_test' : 'rewrite', slug: page.slug, source: 'gsc', why: page.reason, score: page.score, pick: { kind: snippet ? 'snippet' : 'gsc', page } }, page.slug);
      } else if (config.overlays && !catalogDown) {
        // No landing page qualifies: an overlay (shop meta and intro, recipe text) takes the slot.
        add({ type: 'overlay', slug: null, source: 'gsc', why: 'no landing page qualifies, an overlay takes the slot', pick: { kind: 'overlay', rows } });
      }
    }
  }

  for (const kw of toGenerate) {
    add({ type: 'new_page', slug: kw.target_slug, source: kw.source ?? 'gsc', why: `keyword "${kw.keyword}"`, score: kw.score, keyword: kw }, kw.target_slug);
  }
  return out;
}

/** Rybbit stats of the default-locale pages by slug (the shape `selectPage` takes), null without Rybbit. */
export function engagementOf(pages, config) {
  return pages ? Object.fromEntries(pages.filter(p => p.locale === defaultLocale(config)).map(p => [p.slug, p])) : null;
}

/** The queue as the state file keeps it: stable fields only, no scores. The full entries are in the run report. */
export function saveQueue(queue, cwd = process.cwd()) {
  const path = join(cwd, QUEUE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const entries = queue.map(e => ({ type: e.type, slug: e.slug ?? null, source: e.source, status: e.status, reason: e.reason ?? null }));
  writeFileSync(path, JSON.stringify({ version: 1, updated: format(new Date()), entries }, null, 2) + '\n', 'utf8');
}

/** The queue as the run report carries it. */
export const reportQueue = (queue) => queue.map(e => ({
  type: e.type, slug: e.slug ?? null, source: e.source, status: e.status, reason: e.reason ?? null, why: e.why ?? null, score: e.score ?? null,
}));
