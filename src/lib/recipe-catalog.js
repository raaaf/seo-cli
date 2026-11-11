import { safeFetch } from './safe-fetch.js';

const TIMEOUT_MS = 10_000;

// One load per process, like the shop catalog.
let cached = null;

export function resetRecipeCatalogCache() {
  cached = null;
}

const isString = v => typeof v === 'string';
const isStringList = v => Array.isArray(v) && v.every(isString);
const isCount = v => Number.isInteger(v) && v > 0;

/**
 * Throws a descriptive error unless `json` has the recipe catalog shape (version 1):
 * `{ version: 1, recipes: [{ slug, url, title, summary, servings, totalTimeMinutes,
 * ingredients: [string], steps: [string], tags: [string], dietTags: [string] }] }`.
 * These are the published recipes exactly as their pages show them: the only fact
 * source of a recipe overlay.
 */
export function assertRecipeCatalogShape(json) {
  const fail = what => { throw new Error(`Recipe catalog invalid: ${what}`); };
  if (!json || typeof json !== 'object') fail('not an object');
  if (json.version !== 1) fail(`version must be 1, got ${JSON.stringify(json.version)}`);
  if (!Array.isArray(json.recipes)) fail('recipes must be a list');
  for (const r of json.recipes) {
    if (![r?.slug, r?.url, r?.title, r?.summary].every(isString)) fail(`recipe ${JSON.stringify(r?.slug)} needs string slug, url, title, summary`);
    if (!isCount(r.servings) || !isCount(r.totalTimeMinutes)) fail(`recipe ${r.slug}: servings and totalTimeMinutes must be positive integers`);
    for (const key of ['ingredients', 'steps', 'tags', 'dietTags']) {
      if (!isStringList(r[key])) fail(`recipe ${r.slug}: ${key} must be a list of strings`);
    }
  }
  return json;
}

/**
 * Loads the recipe catalog named by `config.recipe_catalog_url`. Null without the key.
 * Throws when the site is unreachable or the file has the wrong shape.
 */
export async function loadRecipeCatalog(config, { fetchImpl = safeFetch } = {}) {
  const url = config.recipe_catalog_url;
  if (!url) return null;
  if (cached?.url === url) return cached.catalog;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`Recipe catalog unreachable (${url}): ${e.message}`, { cause: e });
  }
  if (!res.ok) throw new Error(`Recipe catalog unreachable (${url}): HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Recipe catalog invalid: not JSON (${e.message})`, { cause: e });
  }
  const catalog = assertRecipeCatalogShape(json);
  cached = { url, catalog };
  return catalog;
}

export const findRecipe = (catalog, slug) => catalog?.recipes.find(r => r.slug === slug) ?? null;

/** What the recipe page shows, as lines for the prompt's fact block. */
export function describeRecipe(recipe) {
  return [
    `title: ${recipe.title}`,
    `summary: ${recipe.summary}`,
    `servings: ${recipe.servings}`,
    `total time: ${recipe.totalTimeMinutes} minutes`,
    recipe.tags.length ? `tags: ${recipe.tags.join(', ')}` : null,
    recipe.dietTags.length ? `diet: ${recipe.dietTags.join(', ')}` : null,
    'ingredients:',
    ...recipe.ingredients.map(i => `- ${i}`),
    'steps:',
    ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
  ].filter(v => v !== null).join('\n');
}

const NUMBER = /\d+(?:[.,]\d+)?/g;
const norm = n => n.replace(',', '.').replace(/\.0+$/, '');

/**
 * Numbers of `text` that the recipe does not state (amounts, times, servings, step
 * numbers). An overlay may repeat what the page shows, never add a figure of its own.
 */
export function numbersNotInRecipe(text, recipe) {
  const allowed = new Set((describeRecipe(recipe).match(NUMBER) || []).map(norm));
  recipe.steps.forEach((_, i) => allowed.add(String(i + 1)));
  return [...new Set((String(text).match(NUMBER) || []).map(norm))].filter(n => !allowed.has(n));
}
