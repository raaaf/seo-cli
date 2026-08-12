import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { queryPagePerformance } from '../lib/gsc.js';
import { fillTemplate } from '../lib/template.js';
import { MODELS } from '../lib/models.js';
import { format } from '../lib/date.js';
import { defaultLocale, localeLandingPath } from '../lib/config.js';
import { getExistingSlugs } from '../lib/landings.js';
import { stripCodeFence } from './generate.js';

const IMPROVE_PROMPT = readFileSync(new URL('../prompts/improve.md', import.meta.url), 'utf8');

// A page needs enough impressions for the numbers to mean anything.
const MIN_IMPRESSIONS = 20;
// Queries handed to the model. Beyond this the tail is noise.
const MAX_QUERIES = 15;

// Below this share of impressions on page one, a page is not a snippet problem,
// however good its single best position looks.
const PAGE1_SHARE_FOR_SNIPPET = 0.3;

/**
 * Where the page actually stands, weighted by impressions.
 *
 * The best position across all queries is a trap: one long-tail query at
 * position 1 with two impressions made pages look like page-one performers
 * while their money queries sat on page four. The improve prompt then got told
 * to fix the snippet and rewrote the title of a page that needed content.
 *
 * Without per-query rows (older callers, tests) it falls back to bestPosition.
 */
function diagnose({ queries, bestPosition }) {
  if (!queries?.length) {
    return { position: bestPosition, page1Share: bestPosition <= 10 ? 1 : 0 };
  }
  const total = queries.reduce((sum, q) => sum + q.impressions, 0) || 1;
  const position = queries.reduce((sum, q) => sum + q.position * q.impressions, 0) / total;
  const onPage1 = queries.filter(q => q.position <= 10).reduce((sum, q) => sum + q.impressions, 0);
  return { position, page1Share: onPage1 / total };
}

/**
 * Why a page is worth rewriting, and how much. Two different problems:
 *
 * - It ranks on page one and still gets no clicks. That is the title and the
 *   description, not the content, and it is the cheapest win there is.
 * - It sits just off page one with real impressions. That is a content and
 *   relevance problem, and it is where the volume is.
 */
export function scorePage({ impressions, clicks, bestPosition, queries }) {
  if (impressions < MIN_IMPRESSIONS) return null;

  const { position, page1Share } = diagnose({ queries, bestPosition });
  const where = `weighted position ${position.toFixed(0)} across ${impressions} impressions`;

  if (clicks === 0 && page1Share >= PAGE1_SHARE_FOR_SNIPPET) {
    return {
      score: impressions * 3,
      kind: 'snippet',
      reason: `${Math.round(page1Share * 100)}% of impressions on page one and not a single click (${where}): the snippet is the problem, not the ranking`,
    };
  }
  if (position <= 20) {
    return { score: impressions * 2, kind: 'near_page1', reason: `${where}: within reach of page one` };
  }
  return { score: impressions, kind: 'far', reason: `${where}: relevance gap` };
}

/**
 * Aggregate GSC rows per landing page of the default locale and return the one
 * with the best case for a rewrite, or null when nothing qualifies.
 *
 * `cooldown` is a Set of slugs rewritten recently enough that we have no signal
 * on the last attempt yet.
 */
export function selectPage({ rows, config, cwd = process.cwd(), cooldown = new Set() }) {
  const locale = defaultLocale(config);
  const known = new Set(getExistingSlugs(config, cwd, locale));
  const base = String(config.base_url || '').replace(/\/+$/, '');

  const bySlug = new Map();
  for (const row of rows) {
    const url = String(row.url || '');
    if (base && !url.startsWith(base + '/')) continue;
    const slug = url.slice(base.length + 1).replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!slug || !known.has(slug) || cooldown.has(slug)) continue;

    const entry = bySlug.get(slug) ?? { slug, impressions: 0, clicks: 0, bestPosition: Infinity, queries: [] };
    entry.impressions += row.impressions;
    entry.clicks += row.clicks;
    entry.bestPosition = Math.min(entry.bestPosition, row.position);
    entry.queries.push({ query: row.query, position: row.position, impressions: row.impressions, clicks: row.clicks });
    bySlug.set(slug, entry);
  }

  // A query another landing page ranks better for is not this page's query.
  // Left in, it drives the rewrite towards a neighbour's topic, and both pages
  // end up competing on the same search. Dropped before scoring, so a page does
  // not get picked for impressions it should never have had.
  const bestByQuery = new Map();
  for (const page of bySlug.values()) {
    for (const q of page.queries) {
      const held = bestByQuery.get(q.query);
      if (!held || q.position < held.position) bestByQuery.set(q.query, { slug: page.slug, position: q.position });
    }
  }
  for (const page of bySlug.values()) {
    const own = page.queries.filter(q => bestByQuery.get(q.query)?.slug === page.slug);
    if (own.length === page.queries.length) continue;
    page.foreignQueries = page.queries.filter(q => bestByQuery.get(q.query)?.slug !== page.slug);
    page.queries = own;
    page.impressions = own.reduce((sum, q) => sum + q.impressions, 0);
    page.clicks = own.reduce((sum, q) => sum + q.clicks, 0);
    page.bestPosition = own.length ? Math.min(...own.map(q => q.position)) : Infinity;
  }

  const ranked = [...bySlug.values()]
    .map(page => ({ ...page, ...(scorePage(page) ?? {}) }))
    .filter(page => page.score)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  best.queries.sort((a, b) => b.impressions - a.impressions);
  best.queries = best.queries.slice(0, MAX_QUERIES);
  return best;
}

/** Rewrite one page against the queries it actually ranks for. */
export async function improvePage(page, config, cwd = process.cwd(), validatorFeedback = null) {
  const locale = defaultLocale(config);
  const filePath = join(localeLandingPath(config, locale), `${page.slug}.md`);
  const full = join(cwd, filePath);
  if (!existsSync(full)) throw new Error(`Landing page not found: ${filePath}`);

  const queryTable = page.queries
    .map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`)
    .join('\n');

  // Which topics are taken. Without this the model optimises the page towards
  // whatever the query table shows, including questions a sibling answers.
  const siblings = getExistingSlugs(config, cwd, locale).filter(slug => slug !== page.slug);
  const siblingList = siblings.length
    ? siblings.map(slug => `- /${slug}`).join('\n')
    : '(no other landing pages yet)';

  const prompt = fillTemplate(IMPROVE_PROMPT, {
    markdown: readFileSync(full, 'utf8'),
    slug: page.slug,
    locale,
    site_name: config.site_name || config.project || '',
    today: format(new Date()),
    problem: page.reason,
    kind: page.kind,
    query_table: queryTable,
    sibling_pages: siblingList,
    impressions: page.impressions,
    clicks: page.clicks,
    best_position: page.bestPosition.toFixed(1),
    validator_feedback: validatorFeedback
      ? `The previous attempt failed validation. Fix these issues:\n${validatorFeedback.errors.map(e => `- ${e}`).join('\n')}`
      : '(first attempt — no prior feedback)',
  });

  console.log(chalk.blue(`  Improving ${page.slug}: ${page.reason}${validatorFeedback ? ' (retry)' : ''}`));
  if (page.foreignQueries?.length) {
    const names = page.foreignQueries.slice(0, 5).map(q => `"${q.query}"`).join(', ');
    console.log(chalk.gray(`    ${page.foreignQueries.length} query/queries left out, another page ranks better for them: ${names}`));
  }

  const markdown = stripCodeFence(await complete({
    system: 'You are an experienced SEO editor improving an existing page. You keep what works and change only what the data says is wrong.',
    prompt,
    model: MODELS.generate,
    maxTokens: 8000,
  }));

  return { slug: page.slug, filePath, markdown };
}

/** GSC rows for the project, in the shape selectPage expects. */
export async function fetchPagePerformance(config) {
  // Filter on the project's own base_url: a domain property also carries the
  // sibling subdomains, and they would eat the row limit.
  const rows = await queryPagePerformance(config.gsc_property, { pageFilter: config.base_url || null });
  return rows.map(r => ({
    url: r.keys[0],
    query: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
}
