import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { assertBudget } from '../lib/budget.js';
import { fillTemplate } from '../lib/template.js';
import { MODELS } from '../lib/models.js';
import { format } from '../lib/date.js';
import { SEO_THRESHOLDS } from '../lib/seo-thresholds.js';
import { defaultLocale, localeLandingPath } from '../lib/config.js';
import { parseFrontmatter, splitFrontmatter } from '../lib/frontmatter.js';
import { validate } from './validate.js';
import { keywordFor } from './improve.js';

const SNIPPET_PROMPT = readFileSync(new URL('../prompts/snippet.md', import.meta.url), 'utf8');
const GSC_GUARDRAIL = readFileSync(new URL('../prompts/_gsc-guardrail.md', import.meta.url), 'utf8');

const FIELDS = ['meta_title', 'meta_description'];
const SCHEMA = {
  type: 'object',
  properties: { meta_title: { type: 'string' }, meta_description: { type: 'string' } },
  required: FIELDS,
  additionalProperties: false,
};
const MAX_ATTEMPTS = 2;

// Value of a frontmatter line in the style it already has: single quotes stay single, everything else is
// a double-quoted JSON string (valid YAML).
function formatValue(old, value) {
  if (/^'/.test(old)) return `'${value.replace(/'/g, "''")}'`;
  return JSON.stringify(value);
}

/**
 * Sets `meta_title` and `meta_description` in the frontmatter as a text edit, like `addRelatedPage` does
 * for `related_pages`: everything else, the body byte for byte, stays. Returns null when a field is
 * missing or is not a one-line value (block scalar, continuation lines), so nothing is written wrongly.
 */
export function setMetaFields(markdown, fields) {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  for (const key of FIELDS) {
    const at = lines.findIndex((l, i) => i > 0 && i < end && l.startsWith(`${key}:`));
    if (at === -1) return null;
    const old = lines[at].slice(key.length + 1).trim();
    if (/^[>|]/.test(old) || /^\s+\S/.test(lines[at + 1] ?? '') && at + 1 < end) return null;
    lines[at] = `${key}: ${formatValue(old, String(fields[key]))}`;
  }
  return lines.join('\n');
}

// Errors that count for a snippet: new ones next to the page as it is, or any on the two fields themselves.
// A page that already carries an old defect in its body is not blocked by it.
function snippetErrors(current, next, keyword, opts) {
  const before = new Set(validate(current, keyword, opts).errors);
  return validate(next, keyword, opts).errors.filter(e => !before.has(e) || FIELDS.some(f => e.startsWith(f)));
}

/**
 * Rewrites the meta title and description of one page against the queries it ranks for, and nothing
 * else. Two attempts, the second with the validator's feedback. Returns
 * `{ filePath, markdown, before, after, warnings }`, or `{ failure }` (the errors) when both failed.
 */
export async function snippetPage(page, config, cwd = process.cwd(), validateOpts = {}) {
  const locale = defaultLocale(config);
  const filePath = join(localeLandingPath(config, locale), `${page.slug}.md`);
  const full = join(cwd, filePath);
  if (!existsSync(full)) throw new Error(`Landing page not found: ${filePath}`);
  const current = readFileSync(full, 'utf8');
  const { parsed } = parseFrontmatter(current);
  const before = { title: parsed.meta_title ?? null, description: parsed.meta_description ?? null };
  const keyword = keywordFor(page);
  const t = SEO_THRESHOLDS;

  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = fillTemplate(SNIPPET_PROMPT, {
      slug: page.slug,
      locale,
      site_name: config.site_name || config.project || '',
      today: format(new Date()),
      problem: page.reason,
      gsc_guardrail: GSC_GUARDRAIL,
      current_title: before.title ?? '(none)',
      current_description: before.description ?? '(none)',
      query_table: page.queries.map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`).join('\n'),
      body: splitFrontmatter(current).body,
      title_min: t.metaTitle.idealMin,
      title_max: t.metaTitle.idealMax,
      description_min: t.metaDescription.idealMin,
      description_max: t.metaDescription.idealMax,
      validator_feedback: attempt > 1 ? `\nThe previous attempt failed validation. Fix these issues:\n${errors.map(e => `- ${e}`).join('\n')}\n` : '',
    });
    console.log(chalk.blue(`  Snippet test ${page.slug}: ${page.reason}${attempt > 1 ? ' (retry)' : ''}`));
    assertBudget('anthropic', cwd);
    const result = await complete({
      system: 'You are an experienced SEO editor. You write search snippets that earn the click and promise only what the page delivers.',
      prompt,
      model: MODELS.default,
      maxTokens: 1000,
      json: true,
      schema: SCHEMA,
      batch: false,
    });
    const next = setMetaFields(current, result);
    if (!next) throw new Error(`Cannot edit the meta fields of ${filePath} as text (missing or multi-line)`);
    errors = snippetErrors(current, next, keyword, validateOpts);
    if (!errors.length) {
      return {
        filePath, markdown: next, before,
        after: { title: result.meta_title, description: result.meta_description },
        warnings: validate(next, keyword, validateOpts).warnings,
      };
    }
  }
  return { failure: errors };
}
