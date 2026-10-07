import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { loadConfig, defaultLocale, localeLandingPath } from '../lib/config.js';
import { createBranchAndCommit, openPR, deleteBranch } from '../lib/github.js';
import { commitState } from '../lib/state.js';
import { writeRunLog, llmSummary, budgetSummary } from '../lib/runlog.js';
import { isoWeek } from '../lib/date.js';
import { loadImprovements, saveImprovements, recordImprovement, slugsInCooldown } from '../lib/improvements.js';
import { fetchPagePerformance, selectPage, improvePage, keywordFor } from '../steps/improve.js';
import { validate } from '../steps/validate.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { linkAlternates } from '../steps/counterpart.js';
import { generateValidatedCounterpart } from '../steps/counterpart-loop.js';

/**
 * Selects the one existing page with the strongest case, rewrites it, validates
 * and fact-checks it. Commits nothing and records no cooldown: that happens in
 * publishImprove, once the PR exists.
 *
 * Returns `{ slug, files, record, commitMessage, prTitle, prBody }`, or null when
 * nothing qualified, the rewrite was dropped or this is a dry run.
 */
export async function prepareImprove(opts = {}, cwd = process.cwd()) {
  const config = opts.config ?? loadConfig(cwd);
  const dryRun = opts.dryRun ?? false;
  // A dry run never waits on a batch that outlives the preview; force interactive.
  if (dryRun) config.batch_generation = false;

  console.log(chalk.bold(`\nseo improve — ${config.project}${dryRun ? ' (dry run)' : ''}\n`));

  let rows;
  try {
    rows = await fetchPagePerformance(config);
  } catch (e) {
    console.log(chalk.yellow(`  Search Console unavailable: ${e.message}`));
    return null;
  }

  const page = selectPage({ rows, config, cwd, cooldown: slugsInCooldown(loadImprovements(cwd)) });

  if (!page) {
    console.log(chalk.gray('  No page qualifies: not enough impressions, or everything eligible was rewritten recently.'));
    return null;
  }

  const before = readMeta(page.slug, config, cwd);
  const keywordLike = keywordFor(page);

  // Two attempts, same as generate. A rewrite costs a full Opus call, and a
  // single hard error (one word over the tldr limit) is not worth losing it.
  let filePath, markdown, result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    ({ filePath, markdown } = await improvePage(page, config, cwd, attempt > 1 ? result : null));
    result = validate(markdown, keywordLike);
    if (result.ok) break;
  }

  if (!result.ok) {
    console.log(chalk.red(`  Improvement discarded: the rewrite of ${page.slug} does not validate after 2 attempts`));
    result.errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    return null;
  }

  let finalMarkdown = markdown;
  let factCheckError = null;
  if (config.fact_check !== false && !dryRun) {
    const { markdown: reviewed, findings, unchecked, error } = await reviewPage(markdown, keywordLike, config, cwd);
    // A human reviews this PR, so keep the rewrite but tell them to check the facts.
    if (unchecked) factCheckError = error;
    if (unresolvedSeverity(findings) === 'high') {
      console.log(chalk.red(`  Improvement discarded: unresolved factual error in the rewrite of ${page.slug}`));
      return null;
    }
    if (reviewed !== markdown && validate(reviewed, keywordLike).ok) finalMarkdown = reviewed;
  }

  // The counterpart adapts the already-checked rewrite, so it is not fact-checked
  // separately. A failure keeps the German rewrite and is flagged in the PR body.
  const counterpart = await readaptCounterpart(finalMarkdown, page, keywordLike, config, cwd);

  if (dryRun) {
    // Print the whole file: a dry run exists to be read, and the interesting
    // part of a rewrite (new sections, adjusted FAQ) is below the frontmatter.
    console.log(chalk.cyan(`\n--- ${page.slug} ---\n`));
    console.log(finalMarkdown);
    if (counterpart?.markdown) {
      console.log(chalk.cyan(`\n--- ${counterpart.slug} (${config.counterpart_locale}) ---\n`));
      console.log(counterpart.markdown);
    }
    return null;
  }

  const week = isoWeek();
  return {
    slug: page.slug,
    files: [
      { path: filePath, content: finalMarkdown },
      ...(counterpart?.markdown ? [{ path: counterpart.filePath, content: counterpart.markdown }] : []),
    ],
    record: { slug: page.slug, queries: page.queries.map(q => q.query) },
    commitMessage: `seo: improve ${page.slug} (${week})\n\n${page.reason}`,
    prTitle: `SEO: improve ${page.slug} (${week})`,
    prBody: buildBody(page, before, readMetaFrom(finalMarkdown), {
      factCheckError,
      warnings: validate(finalMarkdown, keywordLike).warnings,
      counterpart,
    }),
  };
}

/**
 * Opens the rewrite as its own PR on seo/improve/<slug>. The cooldown entry,
 * with the PR url, is written only after the PR exists: a rewrite that never
 * reached a PR must not take the page off the list. An existing branch (an
 * earlier PR for this page is still open) skips with a warning instead.
 *
 * Returns the PR url, or null when skipped.
 */
export async function publishImprove(prepared, { config, cwd = process.cwd(), warnings = [] }) {
  const branch = `seo/improve/${prepared.slug}`;

  try {
    await createBranchAndCommit({ files: prepared.files, message: prepared.commitMessage, cwd, repo: config.repo, branch });
  } catch (e) {
    if (e.code !== 'BRANCH_EXISTS') throw e;
    const warning = `Improve skipped: branch ${branch} already exists (an earlier PR for ${prepared.slug} is still open)`;
    console.log(chalk.yellow(`  ${warning}`));
    warnings.push(warning);
    return null;
  }

  let prUrl;
  try {
    prUrl = await openPR({ repo: config.repo, branch, title: prepared.prTitle, body: prepared.prBody });
  } catch (e) {
    // Without a PR the branch is an orphan that would block this page for good.
    await deleteBranch({ repo: config.repo, branch }).catch(err => {
      const warning = `Could not delete orphan branch ${branch}: ${err.message}`;
      console.log(chalk.yellow(`  ${warning}`));
      warnings.push(warning);
    });
    throw e;
  }

  const improvements = loadImprovements(cwd);
  recordImprovement(improvements, prepared.record);
  improvements.entries.at(-1).pr_url = prUrl;
  saveImprovements(improvements, cwd);

  console.log(chalk.green(`  PR opened: ${prUrl}`));
  return prUrl;
}

/**
 * `seo improve`: prepare, state to main, PR, state to main again. Returns the PR
 * url, or null when nothing qualified, the rewrite was dropped or the PR skipped.
 * The run log (`last-run.json`, `runs.jsonl`) is written before the last state
 * commit, also when the PR failed; a dry run writes nothing.
 */
export async function improveCommand(opts = {}, cwd = process.cwd()) {
  const config = opts.config ?? loadConfig(cwd);
  const prepared = await prepareImprove({ ...opts, config }, cwd);
  if (opts.dryRun) return null;

  const report = { status: 'idle', prs: [], budget: null, warnings: [], errors: [] };
  const syncState = (reason) => commitState({ cwd, repo: config.repo, reason });
  const week = isoWeek();
  let prUrl = null;
  try {
    if (prepared) {
      await syncState(`improve ${week}`);
      prUrl = await publishImprove(prepared, { config, cwd, warnings: report.warnings });
      if (prUrl) {
        report.prs.push({ url: prUrl, kind: 'improve', slug: prepared.slug });
        report.status = 'prs_opened';
      }
    }
  } catch (e) {
    report.status = 'failed';
    report.errors.push(e.message);
    throw e;
  } finally {
    try { report.budget = budgetSummary(cwd); } catch (e) { report.warnings.push(`Budget unreadable: ${e.message}`); }
    report.llm = llmSummary(report.warnings);
    try { writeRunLog({ cwd, report, mode: 'improve' }); } catch (e) { report.warnings.push(`Run log not written: ${e.message}`); }
    await syncState(`improve ${week} results`);
  }
  return prUrl;
}

// Re-adapts the counterpart page named by the rewrite's `alternate:` field, keeping
// its slug. Returns null when there is nothing to do, `{ slug, filePath, markdown }`
// on success and `{ slug, failure }` when both attempts failed.
async function readaptCounterpart(finalMarkdown, page, keywordLike, config, cwd) {
  const locale = config.counterpart_locale;
  if (!locale || locale === defaultLocale(config)) return null;

  const alternate = parseFrontmatter(finalMarkdown).parsed?.alternate;
  const filePath = alternate ? join(localeLandingPath(config, locale), `${alternate}.md`) : null;
  if (!filePath || !existsSync(join(cwd, filePath))) {
    console.log(chalk.gray(`  No ${locale} counterpart to re-adapt for ${page.slug} (no alternate page on disk)`));
    return null;
  }

  const result = await generateValidatedCounterpart(keywordLike, finalMarkdown, config, cwd, { fixedSlug: alternate, matchCounts: true });
  if (result.failure) {
    const reason = [result.failure, ...result.errors].join('; ');
    console.log(chalk.yellow(`  Counterpart ${alternate} could not be re-adapted: ${reason}`));
    return { slug: alternate, failure: reason };
  }

  const { counterpartMarkdown } = linkAlternates(finalMarkdown, result.markdown, page.slug, alternate);
  return { slug: alternate, filePath, markdown: counterpartMarkdown };
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

function buildBody(page, before, after, { factCheckError = null, warnings = [], counterpart = null } = {}) {
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

  const warning = factCheckError
    ? [`**ACHTUNG: Der Faktencheck ist nicht gelaufen (${factCheckError}). Bitte alle Fakten, Preise und Zahlen von Hand prüfen.**`, '']
    : [];

  const counterpartNote = !counterpart ? []
    : counterpart.failure
      ? [`**Counterpart ${counterpart.slug} could not be re-adapted: ${counterpart.failure}. Sync by hand before merging, landing-sync tests may fail.**`, '']
      : [`Die Gegenseite \`${counterpart.slug}\` wurde aus der Überarbeitung neu angepasst (gleicher Slug, gleiche Anzahl Schritte, Checklistenpunkte und FAQ).`, ''];

  return [
    ...warning,
    ...counterpartNote,
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
    factCheckError
      ? 'Die Seite wurde nach der Überarbeitung erneut validiert, aber nicht faktengeprüft.'
      : 'Die Seite wurde nach der Überarbeitung erneut validiert und faktengeprüft.',
    '',
    ...(warnings.length ? [`**Validator-Warnungen, die nach der Überarbeitung bleiben:** ${warnings.join(' | ')}`, ''] : []),
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}
