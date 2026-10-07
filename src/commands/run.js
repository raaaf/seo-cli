import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import {
  loadConfig, defaultLocale as getDefaultLocale, localeLandingPath as getLocaleLandingPath, localeUrlPath,
} from '../lib/config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import {
  loadKeywords, saveKeywords, getPending, newPagesThisMonth, KEYWORD_STATUS, releasePending,
  loadSitemapPending, saveSitemapPending,
} from '../lib/keywords.js';
import { loadImprovements, saveImprovements, parseOverlayKey } from '../lib/improvements.js';
import { overlayUrl } from '../lib/measure.js';
import { loadChanges, saveChanges, upsertEntry, markSkipped } from '../lib/changes.js';
import { getPR, deleteBranch } from '../lib/github.js';
import { commitState } from '../lib/state.js';
import { writeReport, writeRunLog, llmSummary, budgetSummary } from '../lib/runlog.js';
import { BudgetExceededError, rethrowIfBudget } from '../lib/budget.js';
import { isoWeek, format } from '../lib/date.js';
import { discover } from '../steps/discover.js';
import { generatePage } from '../steps/generate.js';
import { linkAlternates } from '../steps/counterpart.js';
import { generateValidatedCounterpart } from '../steps/counterpart-loop.js';
import { validate } from '../steps/validate.js';
import { loadCatalog, contractOptions } from '../lib/catalog.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { prepareImprove, publishImprove } from './improve.js';
import { createPRs } from '../steps/pr.js';
import { track } from '../steps/track.js';
import { measure } from '../steps/measure.js';
import { assessAlerts } from '../steps/assess.js';

function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const MAX_COUNTERPART_FAILURES = 2;

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SERPAPI_KEY',
  'GITHUB_TOKEN',
];

// Generate the counterpart page for an already-validated default-locale page.
// Returns { markdown, slug } on success, or null on any failure (invalid/
// colliding slug after retry, or validation failing after 2 attempts) — a
// counterpart failure never loses the default-locale page, it's just skipped.
async function generateCounterpartPage(kw, sourceMarkdown, config, cwd, dryRun, extraExistingSlugs) {
  const counterpartLocale = config.counterpart_locale;
  const label = ` [${counterpartLocale}]`;

  const result = await generateValidatedCounterpart(kw, sourceMarkdown, config, cwd, { extraExistingSlugs, matchCounts: true });
  if (result.failure) {
    console.log(chalk.yellow(`  Counterpart skipped: ${kw.keyword}${label} (${result.failure})`));
    result.errors.forEach(e => console.log(chalk.yellow(`    ⚠ ${e}`)));
    return null;
  }
  const { markdown, slug } = result;

  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${kw.keyword}${label} (slug: ${slug}) ---\n`));
    console.log(markdown.slice(0, 600) + '\n...');
    return null;
  }

  return { markdown, slug };
}

// Generates the default-locale page for `kw`, then (when config.counterpart_locale
// is set) its reciprocal counterpart page. Returns an array of 0-2 page objects
// ({ keyword, slug, score, type, locale, filePath, markdown }).
async function generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeys, catalog) {
  const localeLandingPathStr = getLocaleLandingPath(config, locale);
  const localeConfig = { ...config, locale, landing_path: localeLandingPathStr };
  const label = (config.locales?.length ?? 1) > 1 ? ` [${locale}]` : '';

  const targetFile = join(cwd, localeLandingPathStr, `${kw.target_slug}.md`);
  if (existsSync(targetFile)) {
    console.log(chalk.gray(`  Skipping ${kw.target_slug}${label} — file already exists`));
    kw.status = KEYWORD_STATUS.DONE;
    return [];
  }
  if (generatedKeys.has(`${kw.target_slug}::${locale}`)) {
    console.log(chalk.yellow(`  Skipping ${kw.target_slug}${label} — slug collision with another keyword`));
    return [];
  }

  let markdown;
  let valid = false;
  let lastResult;
  const validateOpts = contractOptions(localeConfig, catalog, cwd, locale);

  for (let attempt = 1; attempt <= 2; attempt++) {
    markdown = await generatePage(kw, localeConfig, cwd, attempt > 1 ? lastResult : null, { catalog });
    lastResult = validate(markdown, kw, validateOpts);
    if (lastResult.ok) { valid = true; break; }
  }

  if (!valid) {
    console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (validation failed after 2 attempts)`));
    (lastResult?.errors ?? []).forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
    return [];
  }

  // Fact check against the live web and against the cluster's published pages.
  // A high-severity finding the reviewer could not patch means the page states
  // something false that we cannot correct automatically — drop it rather than
  // publish it. Everything else is patched and reported.
  if (config.fact_check !== false && !dryRun) {
    const { markdown: reviewed, findings, unchecked, error } = await reviewPage(markdown, kw, localeConfig, cwd, { locale });
    // These pages auto-merge, so a page whose check never ran is not published.
    // The keyword stays proposed: the failure says nothing about the topic, and
    // validation_failed would drop real GSC demand from the backlog for good.
    if (unchecked) {
      console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (fact check did not run: ${error}), retried next run`));
      return [];
    }
    if (unresolvedSeverity(findings) === 'high') {
      console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (unresolved factual error, see finding above)`));
      kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
      return [];
    }
    if (reviewed !== markdown) {
      const afterFix = validate(reviewed, kw, validateOpts);
      if (afterFix.ok) {
        markdown = reviewed;
      } else {
        console.log(chalk.yellow('  Fact-check patches broke validation, keeping the unpatched page'));
      }
    }
  }

  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${kw.keyword}${label} ---\n`));
    console.log(markdown.slice(0, 600) + '\n...');
  }

  const hasCounterpart = locale === defaultLocaleVal
    && config.counterpart_locale
    && config.counterpart_locale !== defaultLocaleVal;

  const counterpart = hasCounterpart
    ? await generateCounterpartPage(kw, markdown, config, cwd, dryRun, [...generatedKeys].map(k => k.split('::')[0]))
    : null;

  if (dryRun) {
    return [];
  }

  // Once a project declares a counterpart locale, the pair is the unit of
  // publication: events' LandingPageTest requires an `alternate` slug on every
  // page, so shipping the source page alone turns main red. Keep the keyword
  // at `proposed` — it comes back next run, when the API is reachable again.
  // A counterpart that keeps failing would be regenerated at full cost every run,
  // so the second dropped pair marks the keyword validation_failed.
  if (hasCounterpart && !counterpart) {
    console.log(chalk.yellow(`  Skipped: ${kw.keyword} — its ${config.counterpart_locale} counterpart failed, and the pair ships together or not at all`));
    kw.counterpart_failures = (kw.counterpart_failures ?? 0) + 1;
    if (kw.counterpart_failures >= MAX_COUNTERPART_FAILURES) {
      kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
      kw.note = `${config.counterpart_locale} counterpart failed in ${kw.counterpart_failures} runs`;
    }
    return [];
  }
  delete kw.counterpart_failures;

  const filePath = join(localeLandingPathStr, `${kw.target_slug}.md`).replace(/\\/g, '/');
  const pages = [];

  if (counterpart) {
    const linked = linkAlternates(markdown, counterpart.markdown, kw.target_slug, counterpart.slug);
    const counterpartLandingPathStr = getLocaleLandingPath(config, config.counterpart_locale);
    const counterpartFilePath = join(counterpartLandingPathStr, `${counterpart.slug}.md`).replace(/\\/g, '/');
    pages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown: linked.sourceMarkdown });
    pages.push({
      keyword: kw.keyword, slug: counterpart.slug, score: kw.score, type: kw.type,
      locale: config.counterpart_locale, filePath: counterpartFilePath, markdown: linked.counterpartMarkdown,
    });
  } else {
    pages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown });
  }

  return pages;
}

// PR state for the reconcile step. A PR that cannot be read stays as it is
// (reported as a warning), so a GitHub hiccup never flips a status.
async function readPR(repo, url, warnings) {
  try {
    return await getPR({ repo, url });
  } catch (e) {
    warnings.push(`Could not read ${url}: ${e.message}`);
    return { state: 'open', mergedAt: null, headRef: null, unreadable: true };
  }
}

// Closed without merge: the branch is an orphan that would block a new PR under
// the same name. A failure to delete it is only a warning.
async function dropClosedBranch(repo, headRef, warnings) {
  if (!headRef) return;
  try {
    await deleteBranch({ repo, branch: headRef });
  } catch (e) {
    warnings.push(`Could not delete branch ${headRef}: ${e.message}`);
  }
}

// Merged PRs older than this are not added to the ledger retroactively: their
// baseline window is long gone from the picture and the readings would be stale.
const BACKFILL_DAYS = 90;

const withinBackfill = (date) => {
  const t = Date.parse(date);
  return Number.isNaN(t) || Date.now() - t <= BACKFILL_DAYS * 24 * 60 * 60 * 1000;
};

function ledgerEntry({ kind, slug, urls, prUrl, mergedAt }) {
  return {
    id: prUrl, kind, slug, urls, pr_url: prUrl, merged_at: mergedAt.slice(0, 10),
    baseline: null, readings: { d28: null, d56: null }, revert_candidate: false,
  };
}

const baseUrlOf = (config) => String(config.base_url || '').replace(/\/+$/, '');

function newPageEntry(kw, mergedAt, config) {
  const paths = kw.sitemap_slugs?.length ? kw.sitemap_slugs : [localeUrlPath(config, kw.target_slug, getDefaultLocale(config))];
  return ledgerEntry({ kind: 'new', slug: kw.target_slug, urls: paths.map(p => baseUrlOf(config) + p), prUrl: kw.pr_url, mergedAt });
}

// The counterpart is named by the page's `alternate:` field, which is only on disk after the merge was pulled.
function rewriteEntry(item, mergedAt, config, cwd) {
  const base = baseUrlOf(config);
  if (parseOverlayKey(item.slug)) {
    return ledgerEntry({ kind: 'rewrite', slug: item.slug, urls: [overlayUrl(config, item.slug)], prUrl: item.pr_url, mergedAt });
  }
  const urls = [base + localeUrlPath(config, item.slug, getDefaultLocale(config))];
  try {
    const file = join(cwd, getLocaleLandingPath(config, getDefaultLocale(config)), `${item.slug}.md`);
    const alternate = config.counterpart_locale ? parseFrontmatter(readFileSync(file, 'utf8')).parsed?.alternate : null;
    if (alternate) urls.push(`${base}${config.counterpart_url_prefix || ''}/${alternate}`);
  } catch { /* page not on disk: measured without its counterpart */ }
  return ledgerEntry({ kind: 'rewrite', slug: item.slug, urls, prUrl: item.pr_url, mergedAt });
}

// Merged PRs the ledger does not know yet: published keywords (the main loop skips
// them) and rewrites merged before the ledger existed. A PR that cannot be read has
// no entry and is tried again next run; one that was read but never qualifies (no real
// merge date, merged more than 90 days ago) goes to `changes.skipped` and is not read
// again. Rewrites already in the ledger without a counterpart pick it up once it is
// on disk. Returns whether a keyword changed.
async function backfillLedger({ config, cwd, changes, keywords, improvements, warnings }) {
  const known = new Map(changes.entries.map(e => [e.id, e]));
  const skipped = new Set(changes.skipped.map(s => s.id));
  let keywordsChanged = false;

  // Whether a merged PR is worth an entry; otherwise it is recorded and never read again.
  const qualifies = (id, mergedAt) => {
    const reason = !mergedAt ? 'no_merge_date' : !withinBackfill(mergedAt) ? 'too_old' : null;
    if (reason) markSkipped(changes, id, reason);
    return !reason;
  };

  for (const kw of keywords.keywords) {
    if (kw.status !== KEYWORD_STATUS.PUBLISHED || !kw.pr_url || known.has(kw.pr_url) || skipped.has(kw.pr_url)) continue;
    const { state, mergedAt } = await readPR(config.repo, kw.pr_url, warnings);
    if (state !== 'merged' || !qualifies(kw.pr_url, mergedAt)) continue;
    if (!kw.published_at) {
      kw.published_at = mergedAt.slice(0, 10);
      keywordsChanged = true;
    }
    upsertEntry(changes, newPageEntry(kw, mergedAt, config));
  }

  for (const item of improvements.entries) {
    if (!item.pr_url || !item.merged_at || skipped.has(item.pr_url)) continue;
    const entry = known.get(item.pr_url);
    if (entry) {
      if (entry.kind === 'rewrite' && entry.urls.length === 1) upsertEntry(changes, rewriteEntry(item, entry.merged_at, config, cwd));
      continue;
    }
    const { state, mergedAt } = await readPR(config.repo, item.pr_url, warnings);
    if (state === 'merged' && qualifies(item.pr_url, mergedAt)) upsertEntry(changes, rewriteEntry(item, mergedAt, config, cwd));
  }
  return keywordsChanged;
}

/**
 * Brings keyword and improvement status in line with the real PR state before
 * anything new is proposed. Merged keyword PR: `published`, its slugs go to
 * sitemap-pending.json. Closed without merge: `rejected` (never proposed
 * again). Open: unchanged. A merged improvement keeps its cooldown, a closed one
 * loses its entry so the page can be picked again.
 */
export async function reconcileState({ config, cwd, warnings }) {
  const keywords = loadKeywords(cwd);
  const sitemap = loadSitemapPending(cwd);
  let keywordsChanged = false;
  let sitemapChanged = false;
  let changes = null;
  try {
    changes = loadChanges(cwd);
  } catch (e) {
    warnings.push(`Change ledger skipped: ${e.message}`);
  }
  const changesBefore = JSON.stringify(changes);

  for (const kw of keywords.keywords) {
    if (!kw.pr_url) continue;
    const needsDate = !kw.pr_opened_at;
    if (kw.status !== KEYWORD_STATUS.PR_OPENED && !needsDate) continue;
    const { state, mergedAt, headRef, createdAt, unreadable } = await readPR(config.repo, kw.pr_url, warnings);
    // PRs opened before pr_opened_at existed: take the date from GitHub so the monthly cap counts them.
    // A PR that was read but has no creation date is marked 'unknown' (never counted) so GitHub is asked once.
    if (needsDate && createdAt) { kw.pr_opened_at = createdAt.slice(0, 10); keywordsChanged = true; }
    else if (needsDate && !unreadable) { kw.pr_opened_at = 'unknown'; keywordsChanged = true; }
    if (kw.status !== KEYWORD_STATUS.PR_OPENED) continue;
    if (state === 'merged') {
      kw.status = KEYWORD_STATUS.PUBLISHED;
      for (const slug of kw.sitemap_slugs ?? []) {
        if (!sitemap.slugs.includes(slug)) { sitemap.slugs.push(slug); sitemapChanged = true; }
      }
      // Only a real merge date makes a ledger entry; a merged PR without one goes through the backfill, which records it as skipped.
      if (mergedAt) {
        kw.published_at = mergedAt.slice(0, 10);
        if (changes) upsertEntry(changes, newPageEntry(kw, mergedAt, config));
      }
      keywordsChanged = true;
    } else if (state === 'closed') {
      kw.status = KEYWORD_STATUS.REJECTED;
      await dropClosedBranch(config.repo, headRef, warnings);
      keywordsChanged = true;
    }
  }

  const improvements = loadImprovements(cwd);
  const kept = [];
  let improvementsChanged = false;
  for (const entry of improvements.entries) {
    if (!entry.pr_url || entry.merged_at) { kept.push(entry); continue; }
    const { state, mergedAt, headRef } = await readPR(config.repo, entry.pr_url, warnings);
    if (state === 'closed') {
      await dropClosedBranch(config.repo, headRef, warnings);
      improvementsChanged = true;
      continue;
    }
    if (state === 'merged') {
      entry.merged_at = mergedAt ?? format(new Date());
      if (mergedAt && changes) upsertEntry(changes, rewriteEntry(entry, mergedAt, config, cwd));
      improvementsChanged = true;
    }
    kept.push(entry);
  }
  improvements.entries = kept;

  if (changes && await backfillLedger({ config, cwd, changes, keywords, improvements, warnings })) keywordsChanged = true;

  if (keywordsChanged) saveKeywords(keywords, cwd);
  if (sitemapChanged) saveSitemapPending({ ...sitemap, updated: format(new Date()) }, cwd);
  if (improvementsChanged) saveImprovements(improvements, cwd);
  if (changes && JSON.stringify(changes) !== changesBefore) saveChanges(changes, cwd);
}

export async function runCommand(opts) {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(chalk.red('\nMissing env vars:'));
    missing.forEach(k => console.error(chalk.red(`  ${k}`)));
    console.error(chalk.gray('\nAdd them to the seo-cli .env file'));
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const dryRun = opts.dryRun ?? false;
  // A dry run never waits on a batch that outlives the preview; force interactive.
  if (dryRun) config.batch_generation = false;
  const locales = config.locales || [config.locale || 'de'];
  const defaultLocaleVal = getDefaultLocale(config);
  const week = isoWeek();

  console.log(chalk.bold(`\nseo run — ${config.project} [${locales.join('+')}] ${dryRun ? '(dry run)' : ''}\n`));

  const report = { status: 'idle', prs: [], budget: null, warnings: [], errors: [] };
  const awaiting = new Set(); // keywords marked pr_opened before their PR exists
  let keywordsData;
  report.warnings.push(...(config.config_warnings ?? []));

  // Machine state goes to main in the finally block too, so a run that fails
  // half way still keeps its status changes and its budget count.
  try {
    // 1. Reconcile status with the real PR state
    if (!dryRun) await reconcileState({ config, cwd, warnings: report.warnings });

    // 1b. Measure merged changes that are due. Never stops the run.
    try {
      report.measurement = await measure({ config, cwd, dryRun, warnings: report.warnings });
    } catch (e) {
      report.warnings.push(`Measurement failed: ${e.message}`);
    }

    // 1c. Content assessment of index alerts the daily watcher found technically clean.
    try {
      report.assessments = await assessAlerts({ config, cwd, dryRun, warnings: report.warnings });
    } catch (e) {
      rethrowIfBudget(e);
      report.warnings.push(`Assessment failed: ${e.message}`);
    }

    // 1d. Product catalog (fact source of a page contract). While the shop is unreachable
    // (maintenance during a deploy) no new page is discovered or generated.
    let catalog = null;
    let catalogDown = false;
    try {
      catalog = await loadCatalog(config);
    } catch (e) {
      catalogDown = true;
      const warning = `${e.message}. Skipping discover and generate this run`;
      console.log(chalk.yellow(`\n${warning}`));
      report.warnings.push(warning);
    }

    // 2. Discover, unless the monthly cap is already used up: its result could not be generated anyway
    const newPagesUsed = newPagesThisMonth(loadKeywords(cwd));
    const remaining = Math.max(0, config.max_new_pages_per_month - newPagesUsed);
    keywordsData = remaining === 0 || catalogDown ? loadKeywords(cwd) : await discover(config, cwd, { catalog });

    // 3. Generate
    const pending = getPending(keywordsData, config.score_cutoff);
    const toGenerate = catalogDown ? [] : pending.slice(0, Math.min(config.weekly_cap, remaining));
    if (remaining < Math.min(config.weekly_cap, pending.length)) {
      const waiting = pending.length - toGenerate.length;
      const warning = `Monthly new-page cap reached (${newPagesUsed} of ${config.max_new_pages_per_month}), ${waiting} keyword(s) wait for next month`;
      console.log(chalk.yellow(`\n${warning}`));
      report.warnings.push(warning);
    }
    const generatedPages = [];
    let prepared = null;

    if (toGenerate.length === 0) {
      // An empty backlog is the normal state once a topic space is covered. The
      // week is better spent on the pages that already rank and get no clicks
      // than on a keyword invented to fill the slot.
      console.log(chalk.gray('\nNo keywords to generate — switching to improving an existing page.'));
      if (!dryRun) prepared = await prepareImprove({ config, dryRun, catalog, skipOverlays: catalogDown }, cwd);
    } else {
      console.log(chalk.bold(`\nGenerating ${toGenerate.length} page(s):\n`));

      const GENERATE_CONCURRENCY = 2;
      const limit = pLimit(GENERATE_CONCURRENCY);
      const generatedKeysAtomic = new Set();
      const tasks = [];
      for (const kw of toGenerate) {
        for (const locale of locales) {
          tasks.push(limit(async () => {
            const pages = await generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeysAtomic, catalog);
            for (const page of pages) {
              generatedKeysAtomic.add(`${page.slug}::${page.locale}`);
              generatedPages.push(page);
              kw.status = KEYWORD_STATUS.PR_OPENED;
              awaiting.add(kw);
            }
            return pages;
          }));
        }
      }
      // Wait for every sibling before rethrowing: a task still running would
      // book its cost after the state commit in `finally`.
      const settled = await Promise.allSettled(tasks);
      const rejected = settled.filter(s => s.status === 'rejected').map(s => s.reason);
      if (rejected.length) throw rejected.find(r => r instanceof BudgetExceededError) ?? rejected[0];
    }

    if (!dryRun) {
      // 4. State to main before the PRs, so the PR branches start from it. The
      // awaiting keywords go in as proposed: a run killed before `finally` must
      // not leave pr_opened without a pr_url (reconcile skips those, discover
      // excludes them). createPRs sets pr_opened together with the pr_url.
      releasePending([...awaiting]);
      saveKeywords(keywordsData, cwd);
      await commitState({ cwd, repo: config.repo, reason: `run ${week}` });

      // 5. One PR per keyword, one per rewrite
      if (generatedPages.length > 0) {
        const created = await createPRs({ generatedPages, keywordsData, config });
        report.prs.push(...created.prs.map(p => ({ url: p.url, kind: 'new', slug: p.slug })));
        report.warnings.push(...created.warnings);
        report.errors.push(...created.errors);
      }
      if (prepared) {
        try {
          const url = await publishImprove(prepared, { config, cwd, warnings: report.warnings });
          if (url) report.prs.push({ url, kind: 'improve', slug: prepared.slug });
        } catch (e) {
          console.error(chalk.red(`\nImprove PR failed: ${e.message}`));
          report.errors.push(`Improve PR failed for ${prepared.slug}: ${e.message}`);
        }
      }

      // 6. Track
      console.log('');
      await track(config, cwd);
    }

    if (report.prs.length > 0) report.status = 'prs_opened';
    else if (report.errors.length > 0) report.status = 'failed';
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      report.status = 'budget_exceeded';
      report.errors.push(e.message);
      console.error(chalk.yellow(`\n${e.message}`));
    } else {
      report.status = 'failed';
      report.errors.push(e.message);
      throw e;
    }
  } finally {
    try { report.budget = budgetSummary(cwd); } catch (e) { report.warnings.push(`Budget unreadable: ${e.message}`); }
    report.llm = llmSummary(report.warnings);
    if (!dryRun) {
      try { writeRunLog({ cwd, report, mode: 'run' }); } catch (e) { report.warnings.push(`Run log not written: ${e.message}`); }
      try {
        releasePending([...awaiting]);
        if (keywordsData) saveKeywords(keywordsData, cwd);
        await commitState({ cwd, repo: config.repo, reason: `run ${week} results` });
      } catch (e) {
        report.warnings.push(`State commit after the run failed: ${e.message}`);
        console.error(chalk.red(`\nState commit after the run failed: ${e.message}`));
      }
    }
    if (opts.report) writeReport(opts.report, report);
  }

  console.log(chalk.bold(`\nAll done (${report.status}).\n`));
}
