import { readFileSync } from 'fs';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { format } from '../lib/date.js';
import { getExistingSlugs } from '../lib/landings.js';
import { fillTemplate } from '../lib/template.js';
import { isValidSlug } from '../lib/keywords.js';
import { MODELS } from '../lib/models.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { defaultLocale } from '../lib/config.js';
import { stripCodeFence } from './generate.js';

const COUNTERPART_PROMPT = readFileSync(new URL('../prompts/counterpart.md', import.meta.url), 'utf8');

/**
 * Generate a counterpart page (a localized adaptation, not a translation) of an
 * already-generated, already-validated source-locale page. The model picks its
 * own slug for the new page; a single retry is made if that slug is invalid or
 * collides with an existing one, then this throws.
 *
 * `opts.extraExistingSlugs` lets the caller add slugs generated earlier in the
 * same run (not yet on disk) to the collision check.
 */
export async function generateCounterpart(sourceMarkdown, keyword, config, cwd = process.cwd(), opts = {}) {
  const sourceLocale = defaultLocale(config);
  const targetLocale = config.counterpart_locale;
  const extraExistingSlugs = opts.extraExistingSlugs || [];

  // Kept separate (not merged) so the prompt can tell the model which slugs
  // belong to which locale: related_pages in the target-locale page must only
  // ever reference target-locale slugs, never a source-locale one.
  const sourceSlugs = Array.from(new Set(getExistingSlugs(config, cwd, sourceLocale)));
  const targetSlugs = Array.from(new Set(getExistingSlugs(config, cwd, targetLocale)));
  // Collision checking still needs the union, plus in-run slugs from either locale.
  const existingSlugs = Array.from(new Set([...sourceSlugs, ...targetSlugs, ...extraExistingSlugs]));

  const runAttempt = async (validatorFeedback) => {
    const feedbackBlock = validatorFeedback
      ? `The previous attempt failed. Fix these issues:\n${validatorFeedback}`
      : '(first attempt — no prior feedback)';

    const vars = {
      source_markdown: sourceMarkdown,
      source_locale: sourceLocale,
      target_locale: targetLocale,
      existing_slugs_source: sourceSlugs.join(', ') || 'none',
      existing_slugs_target: targetSlugs.join(', ') || 'none',
      site_name: config.site_name || config.project || '',
      today: format(new Date()),
      validator_feedback: feedbackBlock,
    };

    const prompt = fillTemplate(COUNTERPART_PROMPT, vars);

    console.log(chalk.blue(`  Generating counterpart (${targetLocale}): ${keyword.keyword}${validatorFeedback ? ' (retry)' : ''}`));

    let markdown = await complete({
      system: 'You are an experienced SEO writer creating a localized adaptation of an existing page, not a literal translation. Follow the instructions exactly.',
      prompt,
      model: MODELS.generate,
      maxTokens: 8000,
    });

    markdown = stripCodeFence(markdown);

    const baseUrl = (config.base_url || '').replace(/\/$/, '');
    markdown = markdown
      .replace(/BASE_URL/g, baseUrl)
      .replace(/SITE_NAME/g, config.site_name || config.project || '');

    return markdown;
  };

  const slugProblem = (slug) => {
    if (!isValidSlug(slug)) return `invalid slug "${slug}"`;
    if (existingSlugs.includes(slug)) return `slug "${slug}" collides with an existing page`;
    return null;
  };

  let markdown = await runAttempt(opts.validatorFeedback);
  let slug = parseFrontmatter(markdown).parsed.slug;
  let problem = slugProblem(slug);

  if (problem) {
    markdown = await runAttempt(
      `Slug rejected: ${problem}. Choose a different short noun-phrase slug that does not appear in: ${existingSlugs.join(', ') || 'none'}.`
    );
    slug = parseFrontmatter(markdown).parsed.slug;
    problem = slugProblem(slug);
    if (problem) {
      throw new Error(`Counterpart generation failed: ${problem} after retry`);
    }
  }

  const canonicalBaseUrl = (config.base_url || '').replace(/\/$/, '');
  markdown = markdown.replace(/CANONICAL_URL/g, `${canonicalBaseUrl}/${slug}`);

  return { markdown, slug };
}

/**
 * Insert reciprocal `alternate:` frontmatter lines into both pages, directly
 * after each page's `slug:` line. Replaces an existing `alternate:` line if
 * present. Pure string manipulation, no I/O.
 */
export function linkAlternates(sourceMarkdown, counterpartMarkdown, sourceSlug, counterpartSlug) {
  return {
    sourceMarkdown: insertAlternate(sourceMarkdown, counterpartSlug),
    counterpartMarkdown: insertAlternate(counterpartMarkdown, sourceSlug),
  };
}

function insertAlternate(markdown, alternateSlug) {
  const withoutExisting = markdown.replace(/^alternate:.*\n/m, '');
  return withoutExisting.replace(/^(slug:.*)$/m, `$1\nalternate: ${alternateSlug}`);
}
