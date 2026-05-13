import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { format } from '../lib/date.js';

const GENERATE_PROMPT = readFileSync(new URL('../prompts/generate.md', import.meta.url), 'utf8');
const DEFAULT_STYLE = readFileSync(new URL('../prompts/style-default.md', import.meta.url), 'utf8');

let styleDocCache = null;
let styleDocCacheKey = null;
const existingSlugsCache = new Map();

export async function generatePage(keyword, config, cwd = process.cwd(), validatorFeedback = null) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(keyword.target_slug || '')) {
    throw new Error(`Invalid target_slug: ${JSON.stringify(keyword.target_slug)}. Must match /^[a-z0-9][a-z0-9-]*$/.`);
  }

  const style = loadStyleDoc(config, cwd);

  const feedbackBlock = validatorFeedback
    ? `The previous attempt failed validation. Fix these issues:\n${validatorFeedback.errors.map(e => `- ${e}`).join('\n')}`
    : '(first attempt — no prior feedback)';

  const prompt = GENERATE_PROMPT
    .replace('{{keyword}}', keyword.keyword)
    .replace('{{slug}}', keyword.target_slug)
    .replace('{{type}}', keyword.type || 'guide')
    .replace('{{intent}}', keyword.intent || 'informational')
    .replace('{{geo_scope}}', keyword.geo_scope || 'global')
    .replace('{{location}}', keyword.location || 'n/a')
    .replace('{{expected_entities}}', (keyword.expected_entities || []).join(', '))
    .replace('{{content_gaps}}', (keyword.content_gaps || []).join(', '))
    .replace('{{primary_cta}}', config.primary_cta || 'trial_signup')
    .replace('{{locale}}', config.locale || 'de')
    .replace('{{people_also_ask}}', (keyword.serp?.people_also_ask || []).join('\n') || 'n/a')
    .replace('{{related_searches}}', (keyword.serp?.related_searches || []).join('\n') || 'n/a')
    .replace('{{existing_slugs}}', getExistingSlugs(config, cwd, config.locale).join(', ') || 'none')
    .replace('{{style}}', style)
    .replace('{{today}}', format(new Date()))
    .replace('{{expected_entities_yaml}}', JSON.stringify(keyword.expected_entities || []))
    .replace('{{validator_feedback}}', feedbackBlock);

  console.log(chalk.blue(`  Generating: ${keyword.keyword}${validatorFeedback ? ' (retry)' : ''}`));

  let markdown = await complete({
    system: 'You are an experienced SEO writer. Follow the instructions exactly.',
    prompt,
    model: 'claude-opus-4-7',
    maxTokens: 8000,
  });

  // Replace schema placeholders
  const baseUrl = (config.base_url || '').replace(/\/$/, '');
  const localePath = config.locale === (config.locales?.[0] ?? config.locale) ? '' : `/${config.locale}`;
  const canonicalUrl = `${baseUrl}${localePath}/${keyword.target_slug}`;
  markdown = markdown
    .replace(/CANONICAL_URL/g, canonicalUrl)
    .replace(/BASE_URL/g, baseUrl)
    .replace(/SITE_NAME/g, config.site_name || config.project || '');

  return markdown;
}

function getExistingSlugs(config, cwd, locale) {
  const defaultLocale = config.locales?.[0] ?? config.locale ?? 'de';
  const basePath = config.landing_path;
  const localePath = basePath.includes(`/${defaultLocale}/`)
    ? basePath.replace(`/${defaultLocale}/`, `/${locale}/`)
    : basePath;
  const cacheKey = `${cwd}::${localePath}::${locale}::${defaultLocale}`;
  if (existingSlugsCache.has(cacheKey)) return existingSlugsCache.get(cacheKey);

  const tryDirs = [localePath];
  if (locale !== defaultLocale) tryDirs.push(basePath);

  let result = [];
  for (const dir of tryDirs) {
    try {
      const full = join(cwd, dir);
      if (!existsSync(full)) continue;
      const slugs = readdirSync(full)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
      if (slugs.length > 0) { result = slugs; break; }
    } catch {}
  }
  existingSlugsCache.set(cacheKey, result);
  return result;
}

function loadStyleDoc(config, cwd) {
  const key = `${cwd}::${config.style_doc || ''}`;
  if (styleDocCacheKey === key) return styleDocCache;
  let result;
  if (!config.style_doc) {
    result = DEFAULT_STYLE;
  } else {
    const path = join(cwd, config.style_doc);
    if (!existsSync(path)) {
      console.log(chalk.yellow(`  style_doc not found at ${path}, using default.`));
      result = DEFAULT_STYLE;
    } else {
      result = readFileSync(path, 'utf8');
    }
  }
  styleDocCache = result;
  styleDocCacheKey = key;
  return result;
}
