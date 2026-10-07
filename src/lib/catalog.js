import { safeFetch } from './safe-fetch.js';
import { getExistingPages } from './landings.js';

const CATALOG_TIMEOUT_MS = 10_000;

// One load per process: the shop caches the file for an hour and clears it on deploy.
let cached = null;

export function resetCatalogCache() {
  cached = null;
}

const isString = v => typeof v === 'string';

/** Throws a descriptive error unless `json` has the catalog shape (version 1). */
export function assertCatalogShape(json) {
  const fail = what => { throw new Error(`Catalog invalid: ${what}`); };
  if (!json || typeof json !== 'object') fail('not an object');
  if (json.version !== 1) fail(`version must be 1, got ${JSON.stringify(json.version)}`);
  if (!Array.isArray(json.categories)) fail('categories must be a list');
  if (!Array.isArray(json.products)) fail('products must be a list');
  if (!json.shipping || !Number.isInteger(json.shipping.cents) || !isString(json.shipping.delivery)) {
    fail('shipping needs integer cents and string delivery');
  }
  for (const c of json.categories) {
    if (![c?.key, c?.label, c?.url].every(isString)) fail('category needs string key, label, url');
  }
  for (const p of json.products) {
    if (![p?.slug, p?.title, p?.category, p?.url, p?.description, p?.material].every(isString)) {
      fail(`product ${JSON.stringify(p?.slug)} needs string slug, title, category, url, description, material`);
    }
    if (!Array.isArray(p.sizes) || !p.sizes.every(isString)) fail(`product ${p.slug}: sizes must be a list of strings`);
  }
  return json;
}

/**
 * Loads the product catalog named by `config.catalog_url`. Null without the key
 * (everything stays as before). Throws when the shop is unreachable or the file
 * has the wrong shape: callers decide between skipping with a warning and failing.
 */
export async function loadCatalog(config, { fetchImpl = safeFetch } = {}) {
  if (!config.catalog_url) return null;
  if (cached?.url === config.catalog_url) return cached.catalog;
  let res;
  try {
    res = await fetchImpl(config.catalog_url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`Catalog unreachable (${config.catalog_url}): ${e.message}`, { cause: e });
  }
  if (!res.ok) throw new Error(`Catalog unreachable (${config.catalog_url}): HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Catalog invalid: not JSON (${e.message})`, { cause: e });
  }
  const catalog = assertCatalogShape(json);
  cached = { url: config.catalog_url, catalog };
  return catalog;
}

/** The shop-wide shipping fact as one line. */
export function formatShipping(catalog) {
  return `shipping: ${(catalog.shipping.cents / 100).toFixed(2).replace('.', ',')} EUR, delivery ${catalog.shipping.delivery}`;
}

/** Compact text of the catalog for the untrusted prompt block. Empty without a catalog. */
export function formatCatalog(catalog) {
  if (!catalog) return '';
  const lines = [
    formatShipping(catalog),
    `categories: ${catalog.categories.map(c => `${c.key} (${c.label})`).join(', ')}`,
    '',
    ...catalog.products.map(p => {
      const facts = [`category ${p.category}`, p.material && `material ${p.material}`, p.sizes.length && `sizes ${p.sizes.join('/')}`].filter(Boolean);
      return `- ${p.slug}: ${p.title} (${facts.join('; ')}) ${p.description}`;
    }),
  ];
  return lines.join('\n');
}

/** Plain-language rules of a page contract for the prompt. Empty without a contract. */
export function formatContract(contract) {
  if (!contract) return '';
  const rules = [];
  if (contract.body_words) rules.push(`Body length: ${contract.body_words[0]} to ${contract.body_words[1]} words.`);
  if (contract.require?.length) rules.push(`Required frontmatter fields: ${contract.require.join(', ')}.`);
  if (contract.forbid?.length) rules.push(`Forbidden frontmatter fields (never emit them): ${contract.forbid.join(', ')}.`);
  if (contract.products) {
    const { min, max, max_overlap: overlap } = contract.products;
    rules.push(`products: ${min ?? 1} to ${max ?? 12} product slugs, taken only from the catalog.`);
    if (overlap != null) rules.push(`At most ${Math.round(overlap * 100)} percent of the products may also appear on any existing page.`);
  }
  if (contract.lowercase) rules.push('Write hero, tldr, headings, FAQ and meta fields entirely in lowercase.');
  if (contract.meta_title_suffix) rules.push(`The site appends "${contract.meta_title_suffix}" to every title: keep meta_title ${contract.meta_title_suffix.length} characters shorter.`);
  if (contract.facts_denylist?.length) rules.push('Never state prices, delivery times, materials or claims such as organic or sustainable unless the catalog states them word for word.');
  return rules.map(r => `- ${r}`).join('\n');
}

const CATALOG_RULES = [
  'Take every product slug and every fact (price, delivery time, material, sizes) only from the product catalog. Do not state anything the catalog does not say.',
  'Derive topics from the saying and meaning of the designs. Use an occasion or a room only when several designs fit it.',
];

/**
 * The prompt section that tells the model about the page contract and the
 * catalog. Empty without both, so a project without the keys gets today's prompt.
 */
export function pageRulesSection(contract, catalog) {
  const rules = [formatContract(contract), ...(catalog ? CATALOG_RULES.map(r => `- ${r}`) : [])].filter(Boolean);
  return rules.length ? `## Page contract (binding, wins over any conflicting rule above)\n\n${rules.join('\n')}` : '';
}

/**
 * The extra `validate()` options of a project with a page contract: contract,
 * catalog, the products of the pages on disk (for the overlap rule) and the
 * reserved paths. Empty object without the keys, so validate stays unchanged.
 */
export function contractOptions(config, catalog, cwd, locale) {
  if (!config.page_contract && !config.reserved_slugs?.length) return {};
  return {
    contract: config.page_contract ?? null,
    catalog,
    existingPages: config.page_contract ? getExistingPages(config, cwd, locale) : [],
    reservedSlugs: config.reserved_slugs ?? [],
  };
}
