import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import * as yaml from 'js-yaml';
import { complete } from '../lib/claude.js';
import { MODELS } from '../lib/models.js';
import { fillTemplate } from '../lib/template.js';
import { format, isoWeek } from '../lib/date.js';
import { SEO_THRESHOLDS } from '../lib/seo-thresholds.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { loadCatalog, formatShipping } from '../lib/catalog.js';
import { loadRecipeCatalog, findRecipe, describeRecipe, numbersNotInRecipe } from '../lib/recipe-catalog.js';
import { loadImprovements, saveImprovements, recordImprovement, slugsInCooldown, overlayKey, parseOverlayKey } from '../lib/improvements.js';
import { urlToSlug } from '../lib/measure.js';
import { scorePage } from './improve.js';
import { loadStyleDoc, icpBlock } from './generate.js';
import { tonalityErrors, lowercaseErrors, unbackedClaimErrors, unsourcedStatisticSentences } from './validate.js';

const OVERLAY_PROMPT = readFileSync(new URL('../prompts/overlay.md', import.meta.url), 'utf8');
const RECIPE_OVERLAY_PROMPT = readFileSync(new URL('../prompts/recipe-overlay.md', import.meta.url), 'utf8');
const GSC_GUARDRAIL = readFileSync(new URL('../prompts/_gsc-guardrail.md', import.meta.url), 'utf8');

const FIELDS = ['meta_title', 'meta_description', 'intro'];
const MAX_QUERIES = 15;
// Product intro 40 to 120 words, category at most 60, recipe 30 to 80 (it replaces the one-line summary).
const INTRO_WORDS = { product: { min: 40, max: 120 }, category: { min: 40, max: 60 }, recipe: { min: 30, max: 80 } };
// A recipe overlay also carries `notes`: the "Gut zu wissen" section below the steps, plain paragraphs.
const NOTES_WORDS = { min: 80, max: 250 };
const NOTES_PARAGRAPHS = { min: 2, max: 4 };
// `config.overlays` keys by overlay type.
const DIR_KEY = { product: 'products', category: 'categories', recipe: 'recipes' };

const fieldsOf = type => (type === 'recipe' ? [...FIELDS, 'notes'] : FIELDS);
const schemaFor = type => ({
  type: 'object',
  properties: Object.fromEntries(fieldsOf(type).map(f => [f, { type: 'string' }])),
  required: fieldsOf(type),
  additionalProperties: false,
});

const wordCount = (text) => String(text).split(/\s+/).filter(Boolean).length;
const dirOf = (config, type) => String(config.overlays?.[DIR_KEY[type]] ?? '').replace(/^\.\//, '').replace(/\/+$/, '');

/** Repo-relative file of an overlay key, null when that kind has no directory configured. */
export function overlayFilePath(config, key) {
  const { type, id } = parseOverlayKey(key);
  const dir = dirOf(config, type);
  return dir ? `${dir}/${id}.md` : null;
}

/** Overlay key of a repo-relative file inside a configured overlay directory, else null. */
export function overlayKeyOfFile(config, file) {
  const clean = String(file).replace(/^\.\//, '');
  for (const type of Object.keys(DIR_KEY)) {
    const dir = dirOf(config, type);
    if (dir && clean.startsWith(`${dir}/`) && clean.endsWith('.md') && !clean.slice(dir.length + 1).includes('/')) {
      return overlayKey(type, clean.slice(dir.length + 1, -3));
    }
  }
  return null;
}

/**
 * The overlay file: three frontmatter fields, no body (the shop renders the fields only).
 * A recipe overlay (`type` 'recipe') writes each field as a JSON string, which is valid YAML
 * and lets the recipe backend read it without a YAML parser, and carries `notes` as the body.
 */
export function renderOverlay(fields, type = 'product') {
  if (type === 'recipe') {
    const head = FIELDS.map(f => `${f}: ${JSON.stringify(String(fields[f]))}`).join('\n');
    return `---\n${head}\n---\n\n${String(fields.notes ?? '').trim()}\n`;
  }
  const data = Object.fromEntries(FIELDS.map(f => [f, fields[f]]));
  return `---\n${yaml.dump(data, { lineWidth: -1 }).trimEnd()}\n---\n`;
}

/** Frontmatter fields of an overlay file (plus the body as `notes`); `error` when it has none or is not valid YAML. */
export function parseOverlay(markdown) {
  const { parsed, matched, error, body } = parseFrontmatter(markdown);
  if (!matched) return { fields: {}, error: 'No YAML frontmatter found' };
  if (error) return { fields: {}, error: `Frontmatter YAML parse error: ${error.message}` };
  const notes = typeof body === 'string' ? body.trim() : '';
  return { fields: notes ? { ...parsed, notes } : parsed, error: null };
}

/**
 * Gate for one overlay: lengths, lowercase, fact denylist, tonality and that
 * the product or category still exists in the catalog (the Printify sync can
 * rename slugs). Pure, no output. Returns `{ ok, errors, warnings }`.
 */
export function validateOverlay(fields, { key, contract = null, catalog = null, recipes = null }) {
  const errors = [];
  const warnings = [];
  const { type, id } = parseOverlayKey(key);

  for (const f of fieldsOf(type)) {
    if (typeof fields[f] !== 'string' || !fields[f].trim()) errors.push(`Missing overlay field: ${f}`);
  }
  const text = (f) => (typeof fields[f] === 'string' ? fields[f] : '');

  if (text('meta_title')) {
    const len = text('meta_title').length;
    const suffixLen = contract?.meta_title_suffix?.length ?? 0;
    const max = SEO_THRESHOLDS.metaTitle.errorMax - suffixLen;
    if (len < SEO_THRESHOLDS.metaTitle.shortWarn - suffixLen) warnings.push(`meta_title short (${len} chars)`);
    if (len > max) errors.push(`meta_title too long (${len} chars, max ${max})`);
  }
  if (text('meta_description')) {
    const len = text('meta_description').length;
    if (len < SEO_THRESHOLDS.metaDescription.shortWarn) warnings.push(`meta_description short (${len} chars, aim 140–160)`);
    if (len > SEO_THRESHOLDS.metaDescription.errorMax) errors.push(`meta_description too long (${len} chars, max ${SEO_THRESHOLDS.metaDescription.errorMax})`);
  }
  if (text('intro')) {
    const words = wordCount(text('intro'));
    const { min, max } = INTRO_WORDS[type];
    if (words < min) errors.push(`intro too short: ${words} words (min ${min})`);
    if (words > max) errors.push(`intro too long: ${words} words (max ${max})`);
    if (/\n\s*\n/.test(text('intro'))) errors.push('intro must be a single paragraph');
  }

  const all = fieldsOf(type).map(text).join('\n');
  errors.push(...tonalityErrors(all));
  if (contract?.lowercase) errors.push(...lowercaseErrors(Object.fromEntries(FIELDS.map(f => [f, fields[f]]))));
  if (type === 'recipe') {
    errors.push(...recipeErrors(text('notes'), all));
    const recipe = recipes ? findRecipe(recipes, id) : null;
    if (recipes && !recipe) errors.push(`Overlay target not in the recipe catalog: ${key}`);
    // The page shows the recipe; the overlay may repeat its figures, never add one.
    if (recipe) {
      const extra = numbersNotInRecipe(all, recipe);
      if (extra.length) errors.push(`Number not stated by the recipe: ${extra.join(', ')} (repeat only amounts, times and servings the recipe shows)`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }
  if (contract?.facts_denylist?.length) errors.push(...unbackedClaimErrors(all, contract.facts_denylist, catalog));

  if (catalog) {
    if (!inCatalog(key, catalog)) errors.push(`Overlay target not in the catalog: ${key}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Notes: 2 to 4 plain paragraphs. The site renders them as escaped text, so markup or a link would show raw.
function recipeErrors(notes, all) {
  const errors = [];
  if (notes) {
    const paragraphs = notes.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const words = wordCount(notes);
    if (words < NOTES_WORDS.min) errors.push(`notes too short: ${words} words (min ${NOTES_WORDS.min})`);
    if (words > NOTES_WORDS.max) errors.push(`notes too long: ${words} words (max ${NOTES_WORDS.max})`);
    if (paragraphs.length < NOTES_PARAGRAPHS.min || paragraphs.length > NOTES_PARAGRAPHS.max) {
      errors.push(`notes must have ${NOTES_PARAGRAPHS.min} to ${NOTES_PARAGRAPHS.max} paragraphs, has ${paragraphs.length}`);
    }
  }
  if (/[#*`<>|[\]]|^\s*[-+]\s/m.test(all)) errors.push('Markup found (headings, lists, emphasis, HTML): write plain prose');
  if (/https?:\/\/|www\./i.test(all)) errors.push('Link found: overlays carry no links');
  for (const sentence of unsourcedStatisticSentences(all)) {
    errors.push(`Unsourced statistic: "${sentence.replace(/\s+/g, ' ').slice(0, 80)}"`);
  }
  return errors;
}

const inCatalog = (key, catalog) => {
  const { type, id } = parseOverlayKey(key);
  if (type === 'recipe') return Boolean(findRecipe(catalog.recipes ? catalog : null, id));
  return type === 'product' ? Boolean(catalog.products?.some(p => p.slug === id)) : Boolean(catalog.categories?.some(c => c.key === id));
};

/**
 * The overlay page with the strongest case in the GSC rows (`/shop/<slug>` and
 * `/shop?category=<key>`), scored like a landing page. Null when none qualifies.
 * `cooldown` holds overlay keys rewritten recently; with a `catalog`, targets
 * the catalog does not know (renamed or removed by the Printify sync) are skipped.
 */
export function selectOverlayPage({ rows, config, cooldown = new Set(), catalog = null }) {
  const byKey = new Map();
  for (const row of rows) {
    const page = urlToSlug(row.url, config, {});
    if (!page?.overlay || cooldown.has(page.slug) || (catalog && !inCatalog(page.slug, catalog))) continue;
    const key = page.slug;
    const entry = byKey.get(key) ?? { slug: key, impressions: 0, clicks: 0, bestPosition: Infinity, queries: [] };
    entry.impressions += row.impressions;
    entry.clicks += row.clicks;
    entry.bestPosition = Math.min(entry.bestPosition, row.position);
    entry.queries.push({ query: row.query, position: row.position, impressions: row.impressions, clicks: row.clicks });
    byKey.set(key, entry);
  }
  const best = [...byKey.values()]
    .map(page => ({ ...page, ...(scorePage(page) ?? {}) }))
    .filter(page => page.score)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  best.queries = best.queries.sort((a, b) => b.impressions - a.impressions).slice(0, MAX_QUERIES);
  return best;
}

/** Start mode: no GSC row of a shop product page in the window, so there is nothing to rank by. */
export const isStartMode = (rows) => !rows.some(r => /^[^?#]*\/shop\//.test(String(r.url)));

/** First catalog product (catalog order) without an overlay file and not rewritten recently. */
export function pickStartTarget({ config, catalog, cwd, cooldown }) {
  const product = catalog.products.find(p => {
    const key = overlayKey('product', p.slug);
    const file = overlayFilePath(config, key);
    return file && !cooldown.has(key) && !existsSync(join(cwd, file));
  });
  if (!product) return null;
  return {
    slug: overlayKey('product', product.slug),
    queries: [],
    impressions: 0,
    clicks: 0,
    bestPosition: null,
    reason: 'Start mode: no Search Console data for shop pages yet, this product has no overlay',
  };
}

// What the shop says about the target, as lines for the prompt's catalog block.
function describeTarget(key, catalog) {
  const { type, id } = parseOverlayKey(key);
  if (type === 'product') {
    const p = catalog.products.find(x => x.slug === id);
    return p && [
      `product: ${p.title}`, `category: ${p.category}`, `description: ${p.description}`,
      p.material && `material: ${p.material}`, p.sizes.length && `sizes: ${p.sizes.join(', ')}`,
    ].filter(Boolean).join('\n');
  }
  const c = catalog.categories.find(x => x.key === id);
  return c && [
    `category: ${c.label}`,
    `products in it: ${catalog.products.filter(p => p.category === id).map(p => p.title).join(', ') || 'none'}`,
  ].join('\n');
}

function rulesFor(key, contract) {
  const { type } = parseOverlayKey(key);
  const suffix = contract?.meta_title_suffix;
  const max = SEO_THRESHOLDS.metaTitle.errorMax - (suffix?.length ?? 0);
  const { min: introMin, max: introMax } = INTRO_WORDS[type];
  return {
    title_rule: `at most ${max} characters${suffix ? ` (the site appends "${suffix}" itself)` : ''}, with the main search term early.`,
    intro_rule: `${introMin} to ${introMax} words.`,
    notes_rule: `${NOTES_PARAGRAPHS.min} to ${NOTES_PARAGRAPHS.max} paragraphs, ${NOTES_WORDS.min} to ${NOTES_WORDS.max} words in total.`,
    rules: contract?.lowercase ? 'Write all three fields entirely in lowercase.' : '',
  };
}

const queryTableOf = target => (target.queries.length
  ? target.queries.map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`).join('\n')
  : '(no Search Console data yet)');

/** Writes the overlay fields for `target` (Sonnet, through the batch API unless disabled). */
export async function generateOverlay({ target, config, cwd, catalog, recipes = null, current, validatorFeedback = null }) {
  const { type, id } = parseOverlayKey(target.slug);
  const feedback = validatorFeedback
    ? `The previous attempt failed validation. Fix these issues:\n${validatorFeedback.errors.map(e => `- ${e}`).join('\n')}`
    : '';
  const common = {
    target: target.slug,
    locale: config.locale || 'de',
    site_name: config.site_name || config.project || '',
    today: format(new Date()),
    problem: target.reason,
    current: current || '(no overlay yet)',
    query_table: queryTableOf(target),
    gsc_guardrail: GSC_GUARDRAIL,
    style_guide: loadStyleDoc(config, cwd),
    icp: icpBlock(config, cwd),
    ...rulesFor(target.slug, config.page_contract),
    validator_feedback: feedback,
  };
  const prompt = type === 'recipe'
    ? fillTemplate(RECIPE_OVERLAY_PROMPT, {
      ...common,
      facts: describeRecipe(findRecipe(recipes, id)),
      diagnosis: target.diagnosis || '(none)',
      siblings: recipes.recipes.filter(r => r.slug !== id).map(r => `- ${r.title}`).join('\n') || '(none)',
    })
    : fillTemplate(OVERLAY_PROMPT, { ...common, facts: describeTarget(target.slug, catalog), shipping: formatShipping(catalog) });
  console.log(chalk.blue(`  Writing overlay ${target.slug}: ${target.reason}${validatorFeedback ? ' (retry)' : ''}`));
  return complete({
    system: type === 'recipe'
      ? 'You write precise, useful recipe copy. You state only what the recipe states.'
      : 'You write precise, factual shop copy. You state only what the catalog states.',
    prompt,
    model: MODELS.default,
    maxTokens: type === 'recipe' ? 4000 : 2000,
    json: true,
    schema: schemaFor(type),
    batch: config.batch_generation !== false,
  });
}

function buildBody(target, before, after) {
  const { type } = parseOverlayKey(target.slug);
  const table = target.queries.slice(0, 8)
    .map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`).join('\n');
  const diff = fieldsOf(type).flatMap(f => [`**${f} vorher:** ${before[f] ?? '(kein Overlay)'}`, `**${f} nachher:** ${after[f]}`, '']);
  const head = type === 'recipe'
    ? `Overlay \`${target.slug}\`: Meta-Angaben, Einleitung und Abschnitt „Gut zu wissen“ für die Rezeptseite. Zutaten und Schritte bleiben, wie sie sind.`
    : `Overlay \`${target.slug}\`: Meta-Angaben und Einleitung für die Shop-Seite. Der Shop liest nur diese drei Felder.`;
  const foot = type === 'recipe'
    ? 'Alle Aussagen stammen aus dem Rezept selbst; Zahlen, die das Rezept nicht nennt, und unbelegte Statistiken sind gesperrt. Nach dem Merge holt der Content-Sync des Servers die Datei, ein Deploy ist nicht nötig.'
    : 'Alle Aussagen stammen aus dem Shop-Katalog; Preise, Lieferzeiten und Materialien ohne Katalogbeleg sind gesperrt. Nach dem Merge ist ein Shop-Deploy nötig.';
  return [
    head,
    '',
    `**Anlass:** ${target.reason}`,
    '',
    ...(table ? ['| Query | Position | Impressionen | Klicks |', '|---|---|---|---|', table, ''] : []),
    ...diff,
    foot,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

/** First recipe (catalog order) without an overlay file and not rewritten recently. */
export function pickRecipeTarget({ config, recipes, cwd, cooldown }) {
  const recipe = recipes.recipes.find(r => {
    const key = overlayKey('recipe', r.slug);
    const file = overlayFilePath(config, key);
    return file && !cooldown.has(key) && !existsSync(join(cwd, file));
  });
  if (!recipe) return null;
  return {
    slug: overlayKey('recipe', recipe.slug),
    queries: [],
    impressions: 0,
    clicks: 0,
    bestPosition: null,
    reason: 'No recipe page has enough Search Console data yet, this recipe has no overlay',
  };
}

async function loadOrSkip(load) {
  try {
    return await load();
  } catch (e) {
    console.log(chalk.yellow(`  Overlay skipped: ${e.message}`));
    return null;
  }
}

/**
 * One overlay per run, as the same `prepared` shape `publishImprove` takes.
 * `target` (from an index assessment: `{ slug, reason, diagnosis, assessed }`) is written as given.
 * Otherwise, with shop traffic in Search Console the page with the strongest case is rewritten;
 * before that (start mode), and whenever no shop page qualifies, a product without an overlay
 * gets one. A recipe site works the same way with its recipe pages and recipe catalog.
 * Null when overlays are off, the catalog is unavailable, nothing qualifies,
 * the text does not validate after 2 attempts, or this is a dry run.
 */
export async function prepareOverlay({ config, cwd = process.cwd(), rows = [], catalog: given = null, target: givenTarget = null, dryRun = false }) {
  if (!config.overlays) return null;
  const wantsRecipes = Boolean(config.overlays.recipes) && (!givenTarget || parseOverlayKey(givenTarget.slug)?.type === 'recipe');
  const wantsShop = Boolean(config.overlays.products || config.overlays.categories) && (!givenTarget || parseOverlayKey(givenTarget.slug)?.type !== 'recipe');
  let catalog = given;
  let recipes = null;
  if (wantsShop) {
    catalog ??= await loadOrSkip(() => loadCatalog(config));
    if (!catalog) console.log(chalk.yellow('  Shop overlays skipped: they need a reachable catalog_url'));
  }
  if (wantsRecipes) {
    recipes = await loadOrSkip(() => loadRecipeCatalog(config));
    if (!recipes) console.log(chalk.yellow('  Recipe overlays skipped: they need a reachable recipe_catalog_url'));
  }
  if (!catalog && !recipes) return null;

  const cooldown = slugsInCooldown(loadImprovements(cwd));
  let target = givenTarget;
  if (target && parseOverlayKey(target.slug)?.type === 'recipe' && !findRecipe(recipes, parseOverlayKey(target.slug).id)) {
    console.log(chalk.yellow(`  Overlay skipped: ${target.slug} is not in the recipe catalog`));
    return null;
  }
  if (!target && catalog && wantsShop) {
    const startMode = isStartMode(rows);
    // A few shop rows end start mode long before any shop page clears the
    // impression floor (punktundpause, 2026-10-22: no overlay at all), so a run
    // without a ranked target still gives the next product without one an overlay.
    const ranked = startMode ? null : selectOverlayPage({ rows, config, cooldown, catalog });
    const fallback = ranked ? null : pickStartTarget({ config, catalog, cwd, cooldown });
    target = ranked
      ?? (fallback && !startMode ? { ...fallback, reason: 'No shop page has enough Search Console data yet, this product has no overlay' } : fallback);
  }
  if (!target && recipes) {
    const recipeRows = rows.filter(r => urlToSlug(r.url, config, {})?.slug?.startsWith('recipe:'));
    target = selectOverlayPage({ rows: recipeRows, config, cooldown, catalog: recipes })
      ?? pickRecipeTarget({ config, recipes, cwd, cooldown });
  }
  if (!target) {
    console.log(chalk.gray('  No overlay to write (no page qualifies and every page has one).'));
    return null;
  }
  const { type } = parseOverlayKey(target.slug);
  const filePath = overlayFilePath(config, target.slug);
  if (!filePath) {
    console.log(chalk.gray(`  No overlay directory configured for ${target.slug}.`));
    return null;
  }

  const currentRaw = existsSync(join(cwd, filePath)) ? readFileSync(join(cwd, filePath), 'utf8') : null;
  const before = currentRaw ? parseOverlay(currentRaw).fields : {};

  let fields, result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    fields = await generateOverlay({ target, config, cwd, catalog, recipes, current: currentRaw, validatorFeedback: attempt > 1 ? result : null });
    result = validateOverlay(fields, { key: target.slug, contract: config.page_contract, catalog, recipes });
    if (result.ok) break;
  }
  if (!result.ok) {
    console.log(chalk.red(`  Overlay discarded: ${target.slug} does not validate after 2 attempts`));
    result.errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    // The normal cooldown, so a target that cannot be written does not win every week.
    if (!dryRun) {
      const improvements = recordImprovement(loadImprovements(cwd), { slug: target.slug, queries: target.queries.map(q => q.query) });
      improvements.entries.at(-1).failed = true;
      saveImprovements(improvements, cwd);
    }
    return null;
  }

  const content = renderOverlay(fields, type);
  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${filePath} ---\n`));
    console.log(content);
    return null;
  }

  const week = isoWeek();
  return {
    slug: target.slug,
    ...(target.assessed ? { assessed: target.assessed } : {}),
    // A git ref cannot contain ':'.
    branch: `seo/improve/${target.slug.replace(':', '-')}`,
    files: [{ path: filePath, content }],
    record: { slug: target.slug, queries: target.queries.map(q => q.query) },
    commitMessage: `seo: overlay ${target.slug} (${week})\n\n${target.reason}`,
    prTitle: `SEO: overlay ${target.slug} (${week})`,
    prBody: buildBody(target, before, fields),
  };
}
