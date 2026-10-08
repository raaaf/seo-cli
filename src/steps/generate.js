import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { format } from '../lib/date.js';
import { getExistingSlugs } from '../lib/landings.js';
import { fillTemplate } from '../lib/template.js';
import { formatCatalog, pageRulesSection } from '../lib/catalog.js';
import { isValidSlug } from '../lib/keywords.js';
import { MODELS, GENERATE_MAX_TOKENS } from '../lib/models.js';
import { isStrict } from '../lib/config.js';
import { STRICT_THRESHOLDS } from '../lib/seo-thresholds.js';

const GENERATE_PROMPT = readFileSync(new URL('../prompts/generate.md', import.meta.url), 'utf8');
const DEFAULT_STYLE = readFileSync(new URL('../prompts/style-default.md', import.meta.url), 'utf8');

// Strict mode (`quality: strict`): no fixed section or FAQ counts, every figure sourced.
export const SOURCES_RULE = 'Every sentence with a percentage or an amount in euros needs a deep link to its source in the same paragraph, or the frontmatter needs a `sources:` entry (a list of `url` and `title`) that covers it. Do not state a figure you cannot source. Never add numbers to reach a count.';

// What a standard project's prompt says today, so its rendered prompt does not change.
const STANDARD_RULES = {
  faq_count: '4–6',
  h2_rule: 'Exactly 4–5 H2 sections',
  numbers_rule: 'Include at least 5 concrete numbers/digits (prices, percentages, counts, dates)',
};
const STRICT_RULES = {
  faq_count: `3–${STRICT_THRESHOLDS.faqMax}, only as many as there are real questions`,
  h2_rule: 'Only as many H2 sections as the topic needs, none added to reach a count',
  numbers_rule: `${SOURCES_RULE} List every external source you used under \`sources:\` in the frontmatter.`,
};

let styleDocCache = null;
let styleDocCacheKey = null;

export async function generatePage(keyword, config, cwd = process.cwd(), validatorFeedback = null, { catalog = null } = {}) {
  if (!isValidSlug(keyword.target_slug)) {
    throw new Error(`Invalid target_slug: ${JSON.stringify(keyword.target_slug)}. Must match /^[a-z0-9][a-z0-9-]*$/.`);
  }

  const style = loadStyleDoc(config, cwd);

  const feedbackBlock = validatorFeedback
    ? `The previous attempt failed validation. Fix these issues:\n${validatorFeedback.errors.map(e => `- ${e}`).join('\n')}`
    : '(first attempt — no prior feedback)';

  const vars = {
    keyword: keyword.keyword,
    slug: keyword.target_slug,
    type: keyword.type || 'guide',
    intent: keyword.intent || 'informational',
    geo_scope: keyword.geo_scope || 'global',
    expected_entities: (keyword.expected_entities || []).join(', '),
    content_gaps: (keyword.content_gaps || []).join(', '),
    locale: config.locale || 'de',
    people_also_ask: (keyword.serp?.people_also_ask || []).join('\n') || 'n/a',
    related_searches: (keyword.serp?.related_searches || []).join('\n') || 'n/a',
    existing_slugs: getExistingSlugs(config, cwd, config.locale).join(', ') || 'none',
    style,
    today: format(new Date()),
    validator_feedback: feedbackBlock,
    ...(isStrict(config) ? STRICT_RULES : STANDARD_RULES),
    catalog: formatCatalog(catalog),
    contract: pageRulesSection(config.page_contract, catalog),
  };

  const prompt = fillTemplate(GENERATE_PROMPT, vars);

  console.log(chalk.blue(`  Generating: ${keyword.keyword}${validatorFeedback ? ' (retry)' : ''}`));

  let markdown = await complete({
    system: 'You are an experienced SEO writer. Follow the instructions exactly.',
    prompt,
    model: MODELS.generate,
    maxTokens: GENERATE_MAX_TOKENS,
    batch: config.batch_generation !== false,
  });

  // The model sometimes wraps the whole document in a ```markdown fence, which
  // pushes the `---` frontmatter off the first line and makes it unparseable.
  markdown = stripCodeFence(markdown);

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

// Remove a surrounding ```/```markdown code fence the model may have added
// around the entire document. Only strips when an opening fence is present, so
// genuine content is never touched. Exported for reuse by steps/counterpart.js.
export function stripCodeFence(text) {
  let t = String(text ?? '').trim();
  const open = t.match(/^```[a-zA-Z]*\n/);
  if (open) {
    t = t.slice(open[0].length).replace(/\n```$/, '');
  }
  return t.trim();
}

export function loadStyleDoc(config, cwd) {
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
