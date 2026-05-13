import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { format } from '../lib/date.js';

const GENERATE_PROMPT = readFileSync(new URL('../prompts/generate.md', import.meta.url), 'utf8');
const DEFAULT_STYLE = readFileSync(new URL('../prompts/style-default.md', import.meta.url), 'utf8');

export async function generatePage(keyword, config, cwd = process.cwd(), validatorFeedback = null) {
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

  // Build locale-specific path: replace locale segment if present, else append locale
  const localePath = basePath.includes(`/${defaultLocale}/`)
    ? basePath.replace(`/${defaultLocale}/`, `/${locale}/`)
    : basePath;

  const tryDirs = [localePath];
  // Fall back to default locale dir if locale-specific has no files
  if (locale !== defaultLocale) tryDirs.push(basePath);

  for (const dir of tryDirs) {
    try {
      const full = join(cwd, dir);
      if (!existsSync(full)) continue;
      const slugs = readdirSync(full)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
      if (slugs.length > 0) return slugs;
    } catch {}
  }
  return [];
}

function loadStyleDoc(config, cwd) {
  if (!config.style_doc) return DEFAULT_STYLE;
  const path = join(cwd, config.style_doc);
  if (!existsSync(path)) {
    console.log(chalk.yellow(`  style_doc not found at ${path}, using default.`));
    return DEFAULT_STYLE;
  }
  return readFileSync(path, 'utf8');
}
