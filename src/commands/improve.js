import { readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { loadConfig, defaultLocale, localeLandingPath } from '../lib/config.js';
import { createBranchAndCommit, openPR } from '../lib/github.js';
import { isoWeek } from '../lib/date.js';
import { loadImprovements, saveImprovements, recordImprovement, slugsInCooldown, IMPROVEMENTS_FILE } from '../lib/improvements.js';
import { fetchPagePerformance, selectPage, improvePage } from '../steps/improve.js';
import { validate } from '../steps/validate.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { parseFrontmatter } from '../lib/frontmatter.js';

/**
 * Rewrite the one existing page with the strongest case for it, based on live
 * Search Console data. Runs standalone (`seo improve`) and as the fallback of
 * `seo run` when the keyword backlog is empty.
 *
 * Returns the PR url, or null when nothing qualified or the rewrite was dropped.
 */
export async function improveCommand(opts = {}, cwd = process.cwd()) {
  const config = opts.config ?? loadConfig(cwd);
  const dryRun = opts.dryRun ?? false;

  console.log(chalk.bold(`\nseo improve — ${config.project}${dryRun ? ' (dry run)' : ''}\n`));

  let rows;
  try {
    rows = await fetchPagePerformance(config);
  } catch (e) {
    console.log(chalk.yellow(`  Search Console unavailable: ${e.message}`));
    return null;
  }

  const improvements = loadImprovements(cwd);
  const page = selectPage({ rows, config, cwd, cooldown: slugsInCooldown(improvements) });

  if (!page) {
    console.log(chalk.gray('  No page qualifies: not enough impressions, or everything eligible was rewritten recently.'));
    return null;
  }

  const before = readMeta(page.slug, config, cwd);
  const { filePath, markdown } = await improvePage(page, config, cwd);

  const keywordLike = { keyword: page.queries[0]?.query ?? page.slug, expected_entities: [] };
  const result = validate(markdown, keywordLike);
  if (!result.ok) {
    console.log(chalk.red(`  Improvement discarded: the rewrite of ${page.slug} does not validate`));
    result.errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    return null;
  }

  let finalMarkdown = markdown;
  if (config.fact_check !== false && !dryRun) {
    const { markdown: reviewed, findings } = await reviewPage(markdown, keywordLike, config, cwd);
    if (unresolvedSeverity(findings) === 'high') {
      console.log(chalk.red(`  Improvement discarded: unresolved factual error in the rewrite of ${page.slug}`));
      return null;
    }
    if (reviewed !== markdown && validate(reviewed, keywordLike).ok) finalMarkdown = reviewed;
  }

  if (dryRun) {
    // Print the whole file: a dry run exists to be read, and the interesting
    // part of a rewrite (new sections, adjusted FAQ) is below the frontmatter.
    console.log(chalk.cyan(`\n--- ${page.slug} ---\n`));
    console.log(finalMarkdown);
    return null;
  }

  recordImprovement(improvements, { slug: page.slug, queries: page.queries.map(q => q.query) });
  saveImprovements(improvements, cwd);

  const week = isoWeek();
  const branch = `seo/improve-${week}`;
  const files = [
    { path: filePath, content: finalMarkdown },
    { path: IMPROVEMENTS_FILE, content: JSON.stringify(improvements, null, 2) + '\n' },
  ];

  await createBranchAndCommit({
    files,
    message: `seo: improve ${page.slug} (${week})\n\n${page.reason}`,
    cwd,
    repo: config.repo,
  });

  const prUrl = await openPR({
    repo: config.repo,
    branch,
    title: `SEO: improve ${page.slug} (${week})`,
    body: buildBody(page, before, readMetaFrom(finalMarkdown)),
  });

  console.log(chalk.green(`  PR opened: ${prUrl}`));
  return prUrl;
}

function readMeta(slug, config, cwd) {
  try {
    const path = join(cwd, localeLandingPath(config, defaultLocale(config)), `${slug}.md`);
    return readMetaFrom(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readMetaFrom(markdown) {
  try {
    const { parsed } = parseFrontmatter(markdown);
    return { title: parsed.meta_title ?? null, description: parsed.meta_description ?? null };
  } catch {
    return null;
  }
}

function buildBody(page, before, after) {
  const queries = page.queries
    .slice(0, 8)
    .map(q => `| ${q.query} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`)
    .join('\n');

  const metaBlock = before && after
    ? [
      '## Titel und Description',
      '',
      `**Vorher:** ${before.title}`,
      `**Nachher:** ${after.title}`,
      '',
      `**Vorher:** ${before.description}`,
      `**Nachher:** ${after.description}`,
    ].join('\n')
    : '';

  return [
    `Überarbeitung von \`${page.slug}\` auf Basis der Suchanfragen der letzten 28 Tage.`,
    '',
    `**Befund:** ${page.reason}`,
    '',
    `Gesamt: ${page.impressions} Impressionen, ${page.clicks} Klicks, beste Position ${page.bestPosition.toFixed(1)}.`,
    '',
    '## Suchanfragen, die die Seite tatsächlich erreichen',
    '',
    '| Query | Position | Impressionen | Klicks |',
    '|---|---|---|---|',
    queries,
    '',
    metaBlock,
    '',
    'Die Seite wurde nach der Überarbeitung erneut validiert und faktengeprüft.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}
