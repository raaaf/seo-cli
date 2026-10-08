import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

export const CONFIG_FILE = 'seo.config.yaml';

export function loadConfig(cwd = process.cwd()) {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error(`${CONFIG_FILE} not found. Run "seo init" first.`);
  }
  const config = { ...DEFAULTS, ...(yaml.load(readFileSync(path, 'utf8')) || {}) };
  config.counterpart_url_prefix = normalizeUrlPrefix(config.counterpart_url_prefix);
  const cap = config.max_new_pages_per_month;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
    config.max_new_pages_per_month = DEFAULTS.max_new_pages_per_month;
    config.config_warnings = [`max_new_pages_per_month must be a number, using ${DEFAULTS.max_new_pages_per_month}`];
  }
  normalizeShopKeys(config);
  return config;
}

const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

// Etappe D keys. Absent keys keep their inert defaults, so a project without
// them behaves exactly as before. A malformed value falls back to the default
// and warns instead of half-enabling a feature.
function normalizeShopKeys(config) {
  const warn = msg => { config.config_warnings = [...(config.config_warnings || []), msg]; };
  for (const key of ['page_contract', 'overlays']) {
    if (config[key] != null && !isPlainObject(config[key])) {
      warn(`${key} must be a mapping, ignoring it`);
      config[key] = DEFAULTS[key];
    }
  }
  if (config.page_contract) assertPageContractShape(config.page_contract);
  if (!Array.isArray(config.reserved_slugs)) {
    if (config.reserved_slugs != null) warn('reserved_slugs must be a list, ignoring it');
    config.reserved_slugs = [];
  }
  if (typeof config.catalog_url !== 'string' || !config.catalog_url.trim()) config.catalog_url = null;
  config.watch = { ...DEFAULTS.watch, ...(isPlainObject(config.watch) ? config.watch : {}) };
}

const isStringList = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const isNumber = v => typeof v === 'number' && Number.isFinite(v);

// A contract with a wrong shape would crash validate halfway or silently never fire, so it stops the load.
const CONTRACT_SHAPES = {
  body_words: [v => Array.isArray(v) && v.length === 2 && v.every(isNumber), 'a list of two numbers [min, max]'],
  require: [isStringList, 'a list of strings'],
  forbid: [isStringList, 'a list of strings'],
  products: [v => isPlainObject(v) && ['min', 'max', 'max_overlap'].every(k => v[k] == null || isNumber(v[k])), 'a mapping with numeric min, max, max_overlap'],
  lowercase: [v => typeof v === 'boolean', 'true or false'],
  facts_denylist: [isStringList, 'a list of regex strings'],
  meta_title_suffix: [v => typeof v === 'string', 'a string'],
};

function assertPageContractShape(contract) {
  for (const [key, [valid, expected]] of Object.entries(CONTRACT_SHAPES)) {
    if (contract[key] != null && !valid(contract[key])) throw new Error(`${CONFIG_FILE}: page_contract.${key} must be ${expected}`);
  }
}

function normalizeUrlPrefix(prefix) {
  const trimmed = String(prefix || '').replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function saveConfig(config, cwd = process.cwd()) {
  const path = join(cwd, CONFIG_FILE);
  writeFileSync(path, yaml.dump(config, { lineWidth: 120 }), 'utf8');
}

export const DEFAULTS = {
  locale: 'de',
  primary_cta: 'trial_signup',
  style_doc: null,
  score_cutoff: 7,
  weekly_cap: 2,
  // New pages per project and calendar month, counted from the keyword log. Rewrites do not count.
  max_new_pages_per_month: 4,
  min_impressions: 5,
  counterpart_locale: null,
  // Root-relative URL prefix for counterpart pages, e.g. '/en' when the
  // target site serves them under their own path segment instead of sharing
  // the bare /{slug} URL space with the default locale. Normalized on load:
  // trailing slash stripped, leading slash enforced when non-empty.
  counterpart_url_prefix: '',
  // Invent keywords when Search Console yields none. Off by default: an empty
  // backlog means the topic space is covered, not that the week needs filling.
  greenfield: false,
  // Verify checkable claims against the live web before a page is committed.
  fact_check: true,
  // 'strict' turns on the content rules for sites that were demoted for thin or
  // duplicated pages: duplicate blocks, unsourced numbers, FAQ cap, product facts.
  // Anything else leaves validation, review and prompts exactly as they were.
  quality: 'standard',
  // Slugs the improve step must never rewrite: hand-written service and pricing
  // pages, whose claims the model cannot verify.
  exclude_slugs: [],
  // The key is public by design: IndexNow verifies it via `<base_url>/<key>.txt`,
  // which the target repo hosts in its public directory. Null disables the command.
  indexnow_key: null,
  // Page generation goes through the Message Batches API at half price.
  // Set false to force interactive calls (dry runs and debugging).
  batch_generation: true,
  // Per project and calendar month. Checked before every paid SerpAPI search
  // and Anthropic call, state in seo/budget.json. 60 SerpAPI searches per
  // project keeps up to 4 projects under the shared 250/month free tier.
  budget: { usd_per_month: 30, serpapi_per_month: 60 },
  // Page contract: project-specific rules on top of the landing format, read by
  // validate, check, the prompts and the gate. Null keeps today's rules.
  page_contract: null,
  // One-segment paths the site already serves; no landing page may take them.
  reserved_slugs: [],
  // Machine-readable product catalog (the fact source for contract projects). Null: no catalog.
  catalog_url: null,
  // Directories of per-product and per-category overlay files, e.g.
  // { products: 'content/seo/products', categories: 'content/seo/categories' }. Null: no overlays.
  overlays: null,
  // check_deploy: verify that merged pages and overlays are live (opt-in).
  watch: { check_deploy: false },
};

export function isStrict(config) {
  return config?.quality === 'strict';
}

export function defaultLocale(config) {
  return config.locales?.[0] ?? config.locale ?? 'de';
}

export function localeLandingPath(config, locale) {
  const base = config.landing_path;
  const def = defaultLocale(config);
  if (locale === def) return base;
  if (base.includes(`/${def}/`)) return base.replace(`/${def}/`, `/${locale}/`);
  // No default-locale segment in the path: append the locale so a non-default
  // locale never collides into the default locale's directory.
  return base.replace(/\/*$/, `/${locale}/`);
}

// Public URL path for a slug in a given locale. The default locale carries no
// locale prefix; others are prefixed with `{locale}/`. Single source of truth
// for the default-locale rule, shared by pr.js (sitemap slugs + hreflang).
export function localeUrlPath(config, slug, locale) {
  const def = defaultLocale(config);
  return `/${locale === def ? '' : `${locale}/`}${slug}`;
}
