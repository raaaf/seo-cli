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

/**
 * Why a page is worth rewriting, and how much. Two different problems:
 *
 * - It ranks on page one and still gets no clicks. That is the title and the
 *   description, not the content, and it is the cheapest win there is.
 * - It sits just off page one with real impressions. That is a content and
 *   relevance problem, and it is where the volume is.
 */
export function scorePage({ impressions, clicks, bestPosition }) {
  if (impressions < MIN_IMPRESSIONS) return null;
  if (clicks === 0 && bestPosition <= 5) {
    return { score: impressions * 3, kind: 'snippet', reason: `Position ${bestPosition.toFixed(0)} without a single click: the snippet is the problem, not the ranking` };
  }
  if (bestPosition <= 20) {
    return { score: impressions * 2, kind: 'near_page1', reason: `Position ${bestPosition.toFixed(0)} with ${impressions} impressions: within reach of page one` };
  }
  return { score: impressions, kind: 'far', reason: `Position ${bestPosition.toFixed(0)} with ${impressions} impressions: relevance gap` };
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
export async function improvePage(page, config, cwd = process.cwd()) {
  const locale = defaultLocale(config);
  const filePath = join(localeLandingPath(config, locale), `${page.slug}.md`);
  const full = join(cwd, filePath);
  if (!existsSync(full)) throw new Error(`Landing page not found: ${filePath}`);

  const queryTable = page.queries
    .map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`)
    .join('\n');

  const prompt = fillTemplate(IMPROVE_PROMPT, {
    markdown: readFileSync(full, 'utf8'),
    slug: page.slug,
    locale,
    site_name: config.site_name || config.project || '',
    today: format(new Date()),
    problem: page.reason,
    kind: page.kind,
    query_table: queryTable,
    impressions: page.impressions,
    clicks: page.clicks,
    best_position: page.bestPosition.toFixed(1),
  });

  console.log(chalk.blue(`  Improving ${page.slug}: ${page.reason}`));

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
  const rows = await queryPagePerformance(config.gsc_property);
  return rows.map(r => ({
    url: r.keys[0],
    query: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
}
