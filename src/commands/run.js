import { join, basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import {
  loadConfig, defaultLocale as getDefaultLocale, localeLandingPath as getLocaleLandingPath, localeUrlPath, siteInfo,
} from '../lib/config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import {
  loadKeywords, saveKeywords, getPending, newPagesThisMonth, KEYWORD_STATUS, releasePending,
} from '../lib/keywords.js';
import { loadImprovements, saveImprovements, parseOverlayKey } from '../lib/improvements.js';
import { overlayUrl } from '../lib/measure.js';
import { loadChanges, saveChanges, upsertEntry, markSkipped, REWRITE_KINDS } from '../lib/changes.js';
import { getPR, deleteBranch } from '../lib/github.js';
import { strictValidateOpts } from '../lib/landings.js';
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
import { refreshBingQueries } from '../lib/signals/bing.js';
import { rybbitActive, rybbitReport } from '../lib/signals/rybbit.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { prepareImprove, publishImprove, preparePrune } from './improve.js';
import { createPRs } from '../steps/pr.js';
import { track } from '../steps/track.js';
import { measure } from '../steps/measure.js';
import { assessAlerts } from '../steps/assess.js';
import { activeSeasons } from '../lib/seasons.js';
import { annotateFollowups } from '../lib/assessed-rewrite.js';
import { loadAlerts } from '../lib/watch.js';
import { loadIndexStatus } from '../lib/index-status.js';
import { buildQueue, nextInLine, DRAFT_TYPES, predictedOf } from '../lib/queue.js';
import { revertWorseRewrites } from '../steps/revert.js';
import { collectCandidates, engagementOf, saveQueue, reportQueue } from '../steps/queue.js';
import { submitFixes } from '../steps/diagnose.js';
import { fetchLive, isLive } from '../steps/watch.js';

// Slugs of every page a prepared rewrite PR writes or deletes (rewrite, counterpart, merge, link edits).
function touchedSlugs(preparedList) {
  // The overlay key too (recipe:<slug>): an overlay file is named after its page, not its key.
  return preparedList.flatMap(p => [...(p.files ?? []).map(f => basename(f.path, '.md')), ...(parseOverlayKey(p.slug) ? [p.slug] : [])]);
}

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

// What a queue entry tells the PR and the ledger: type, source, reason, score (none for picks without one).
const whyOf = (entry) => ({ type: entry.type, source: entry.source, why: entry.why, score: entry.score || null });

// Report `kind` and, for the proposals that name an alert, what the mail needs to follow it up.
function prKind(prepared) {
  if (prepared.mergeAlert) return { kind: 'merge', from: prepared.mergeFrom, assessed: prepared.mergeAlert };
  if (prepared.pruneAlert) return { kind: 'prune', into: prepared.into, assessed: prepared.pruneAlert };
  return { kind: prepared.snippet ? 'snippet' : prepared.faq ? 'faq' : 'improve', ...(prepared.assessed ? { assessed: prepared.assessed } : {}) };
}

// Warning text of an entry whose preparation threw, in the words the earlier slots used.
function failureWarning(entry, e) {
  if (entry.type === 'merge') return `Merge proposal failed (${entry.pick.from} into ${entry.slug}): ${e.message}`;
  if (entry.type === 'prune') return `Removal proposal failed (${entry.slug}): ${e.message}`;
  if (entry.source === 'season') return `Seasonal rewrite failed: ${e.message}`;
  if (entry.source === 'alert') return `Assessed rewrite failed: ${e.message}`;
  return `${entry.type} failed (${entry.slug ?? 'no page'}): ${e.message}`;
}


// Ledger entries for the queue's brake; an unreadable ledger is a warning and no brake.
function ledgerEntries(cwd, warnings) {
  try {
    return loadChanges(cwd).entries;
  } catch (e) {
    warnings.push(`Change ledger unreadable for the queue: ${e.message}`);
    return [];
  }
}

// A revert decision as a queue entry. Only an opened PR counts against the cap.
function revertEntry(r) {
  const status = r.status === 'opened' ? 'opened' : r.status === 'deferred' ? 'deferred' : 'blocked';
  return {
    type: 'revert', slug: r.slug, source: 'ledger', why: 'rewrite measured worse than its control pages after 28 and 56 days',
    status, reason: status === 'opened' ? null : r.reason ?? r.status, touches: [r.slug],
  };
}

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
async function generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeys, catalog, acceptedPages = []) {
  const localeLandingPathStr = getLocaleLandingPath(config, locale);
  // landing_path stays the configured one: every consumer resolves the locale
  // directory itself (localeLandingPath), and a pre-rewritten path made that
  // content/en/en/ for non-default locales.
  const localeConfig = { ...config, locale };
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
  const validateOpts = {
    ...strictValidateOpts(config, join(cwd, localeLandingPathStr), [kw.target_slug]),
    ...contractOptions(localeConfig, catalog, cwd, locale),
  };
  // The overlap rule also compares against pages accepted earlier in this run, which are not on disk yet.
  const withAccepted = () => (validateOpts.existingPages ? { ...validateOpts, existingPages: [...validateOpts.existingPages, ...acceptedPages.filter(p => p.locale === locale)] } : validateOpts);

  for (let attempt = 1; attempt <= 2; attempt++) {
    markdown = await generatePage(kw, localeConfig, cwd, attempt > 1 ? lastResult : null, { catalog });
    lastResult = validate(markdown, kw, withAccepted());
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
    ? await generateCounterpartPage(kw, markdown, config, cwd, dryRun, [kw.target_slug, ...[...generatedKeys].map(k => k.split('::')[0])])
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

  // Generation runs concurrently, so a sibling may have been accepted while this page waited on the
  // fact check: compare once more, with no await between the check and the registration.
  if (validateOpts.existingPages) {
    const overlap = validate(markdown, kw, withAccepted()).errors.filter(e => e.startsWith('Product overlap'));
    if (overlap.length) {
      console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (overlaps a page of this run)`));
      overlap.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
      kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
      return [];
    }
    const products = parseFrontmatter(markdown).parsed?.products;
    acceptedPages.push({ slug: kw.target_slug, locale, products: Array.isArray(products) ? products : [] });
  }

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

// `predicted` is what the queue expected of the change (`{ type, score, basis }`), kept for the later look back.
function ledgerEntry({ kind, slug, urls, prUrl, mergedAt, predicted }) {
  return {
    id: prUrl, kind, slug, urls, pr_url: prUrl, merged_at: mergedAt.slice(0, 10),
    baseline: null, readings: { d28: null, d56: null }, revert_candidate: false,
    ...(predicted ? { predicted } : {}),
  };
}

const baseUrlOf = (config) => String(config.base_url || '').replace(/\/+$/, '');

function newPageEntry(kw, mergedAt, config) {
  const paths = kw.sitemap_slugs?.length ? kw.sitemap_slugs : [localeUrlPath(config, kw.target_slug, getDefaultLocale(config))];
  return ledgerEntry({ kind: 'new', slug: kw.target_slug, urls: paths.map(p => baseUrlOf(config) + p), prUrl: kw.pr_url, mergedAt, predicted: kw.queue });
}

// The counterpart is named by the page's `alternate:` field, which is only on disk after the merge was pulled.
// A revert PR (improvements entry with `revert: true`) is measured like a rewrite, as kind `revert`, a
// snippet test (`snippet: true`) as kind `snippet`, FAQ answers (`faq: true`) as kind `faq`.
function rewriteEntry(item, mergedAt, config, cwd) {
  const base = baseUrlOf(config);
  const kind = item.revert ? 'revert' : item.snippet ? 'snippet' : item.faq ? 'faq' : 'rewrite';
  const predicted = item.queue;
  if (parseOverlayKey(item.slug)) {
    return ledgerEntry({ kind, slug: item.slug, urls: [overlayUrl(config, item.slug)], prUrl: item.pr_url, mergedAt, predicted });
  }
  const urls = [base + localeUrlPath(config, item.slug, getDefaultLocale(config))];
  try {
    const file = join(cwd, getLocaleLandingPath(config, getDefaultLocale(config)), `${item.slug}.md`);
    const alternate = config.counterpart_locale ? parseFrontmatter(readFileSync(file, 'utf8')).parsed?.alternate : null;
    if (alternate) urls.push(`${base}${config.counterpart_url_prefix || ''}/${alternate}`);
  } catch { /* page not on disk: measured without its counterpart */ }
  return ledgerEntry({ kind, slug: item.slug, urls, prUrl: item.pr_url, mergedAt, predicted });
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
    if (!item.pr_url || !item.merged_at || item.prune || skipped.has(item.pr_url)) continue;
    const entry = known.get(item.pr_url);
    if (entry) {
      if (REWRITE_KINDS.includes(entry.kind) && entry.urls.length === 1) upsertEntry(changes, rewriteEntry(item, entry.merged_at, config, cwd));
      continue;
    }
    const { state, mergedAt } = await readPR(config.repo, item.pr_url, warnings);
    if (state === 'merged' && qualifies(item.pr_url, mergedAt)) upsertEntry(changes, rewriteEntry(item, mergedAt, config, cwd));
  }
  return keywordsChanged;
}

// A draft the owner merged by hand is not seen by the gate, which resubmits the sitemap after a merge it
// did itself. Once per run, for the held drafts found merged in this run; with `watch.check_deploy` only
// for pages that are live. A failure is a warning, never an error.
async function resubmitAfterHandMerge({ config, cwd, entries, submit, fetchPage, warnings }) {
  try {
    let urls = entries.map(e => baseUrlOf(config) + localeUrlPath(config, e.prune ? e.into : e.slug, getDefaultLocale(config)));
    if (config.watch?.check_deploy) {
      const live = [];
      for (const url of urls) if (await isLive({ slug: url, urls: [url] }, { config, cwd, fetchPage }) === true) live.push(url);
      if (live.length < urls.length) warnings.push(`Sitemap resubmit after a hand merge skipped for ${urls.length - live.length} page(s): not live yet`);
      urls = live;
    }
    if (urls.length) await submit({ config, urls });
  } catch (e) {
    warnings.push(`Sitemap resubmit after a hand merge failed: ${e.message}`);
  }
}

/**
 * Brings keyword and improvement status in line with the real PR state before
 * anything new is proposed. Merged keyword PR: `published`. Closed without
 * merge: `rejected` (never proposed again). Open: unchanged. A merged
 * improvement keeps its cooldown, a closed one loses its entry so the page can
 * be picked again.
 */
export async function reconcileState({ config, cwd, warnings, submit = submitFixes, fetchPage = fetchLive }) {
  const keywords = loadKeywords(cwd);
  let keywordsChanged = false;
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
  const handMerged = [];
  let improvementsChanged = false;
  for (const entry of improvements.entries) {
    if (!entry.pr_url || entry.merged_at || entry.closed_at) { kept.push(entry); continue; }
    const { state, mergedAt, headRef } = await readPR(config.repo, entry.pr_url, warnings);
    if (state === 'closed') {
      await dropClosedBranch(config.repo, headRef, warnings);
      improvementsChanged = true;
      // A draft the owner closed stays, so the page keeps its cooldown and the same draft is not proposed again next week.
      if (entry.held) { entry.closed_at = format(new Date()); kept.push(entry); }
      continue;
    }
    if (state === 'merged') {
      entry.merged_at = mergedAt ?? format(new Date());
      if (entry.held) handMerged.push(entry);
      // A removal deletes the page: nothing to measure.
      if (mergedAt && changes && !entry.prune) upsertEntry(changes, rewriteEntry(entry, mergedAt, config, cwd));
      improvementsChanged = true;
    }
    kept.push(entry);
  }
  improvements.entries = kept;
  if (handMerged.length) await resubmitAfterHandMerge({ config, cwd, entries: handMerged, submit, fetchPage, warnings });

  if (changes && await backfillLedger({ config, cwd, changes, keywords, improvements, warnings })) keywordsChanged = true;

  if (keywordsChanged) saveKeywords(keywords, cwd);
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

  const report = { status: 'idle', prs: [], site: siteInfo(config), budget: null, warnings: [], errors: [] };
  const awaiting = new Set(); // keywords marked pr_opened before their PR exists
  let keywordsData;
  let queue = null;
  const maxPrs = config.max_prs_per_run ?? 4;
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

    // 1b1. Take back rewrites that measured worse twice (a PR the gate merges). Before the queue, so the page is in its
    // cooldown and not rewritten again in this run. One slot of the cap stays free for page work.
    const executed = [];
    if (!dryRun) {
      try {
        const reverts = await revertWorseRewrites({ config, cwd, warnings: report.warnings, max: Math.max(0, maxPrs - 1) });
        if (reverts.length) report.reverts = reverts;
        for (const r of reverts) {
          if (r.status === 'opened') report.prs.push({ url: r.pr_url, kind: 'revert', slug: r.slug });
          executed.push(revertEntry(r));
        }
      } catch (e) {
        report.warnings.push(`Revert step failed: ${e.message}`);
      }
    }

    // 1b2. Rybbit weekly signals per landing page. Never stops the run; a failure shows up in the mail as a task.
    let rybbit = null;
    if (rybbitActive(config, report.warnings)) {
      try {
        rybbit = await rybbitReport({ config, cwd, dryRun, warnings: report.warnings });
        report.rybbit = rybbit.report;
      } catch (e) {
        rybbit = null;
        report.warnings.push(`Rybbit: ${String(e.message).split('\n')[0]}`);
        report.rybbit = { error: 'error' };
      }
    }

    // 1c. Content assessment of index alerts the daily watcher found technically clean.
    try {
      report.assessments_waiting = [];
      report.assessments = await assessAlerts({ config, cwd, dryRun, warnings: report.warnings, waiting: report.assessments_waiting, engagement: rybbit?.pages ?? [] });
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
    const keywordsBefore = loadKeywords(cwd);
    const newPagesUsed = newPagesThisMonth(keywordsBefore);
    const remaining = Math.max(0, config.max_new_pages_per_month - newPagesUsed);
    const discovering = remaining > 0 && !catalogDown;

    // 1e. Bing queries for discover (start mode) and generate (FAQ questions), refreshed weekly. Never fatal.
    // Only when discover runs, so the answer is used this run (a dry run still writes just the local signal file).
    if (discovering) await refreshBingQueries({ config, cwd, warnings: report.warnings });
    keywordsData = discovering ? await discover(config, cwd, { catalog }) : loadKeywords(cwd);

    // 3. The queue: every candidate from every source, ranked, then locks, brake and the cap on PRs.
    const pending = getPending(keywordsData, config.score_cutoff);
    const due = catalogDown ? [] : pending.slice(0, Math.min(config.weekly_cap, remaining));
    if (remaining < Math.min(config.weekly_cap, pending.length)) {
      const waiting = pending.length - due.length;
      const warning = `Monthly new-page cap reached (${newPagesUsed} of ${config.max_new_pages_per_month}), ${waiting} keyword(s) wait for next month`;
      console.log(chalk.yellow(`\n${warning}`));
      report.warnings.push(warning);
    }
    const generatedPages = [];
    // Rewrites of this run, each with the queue entry it came from.
    const preparedList = [];
    const entryOf = new Map();
    let refreshedSlug = null;

    const candidates = await collectCandidates({ config, cwd, catalogDown, toGenerate: due, engagement: engagementOf(rybbit?.pages, config), warnings: report.warnings });
    const built = buildQueue({
      candidates, executed, config, today: format(new Date()),
      alerts: loadAlerts(cwd, []).open, changes: ledgerEntries(cwd, report.warnings),
      improvements: loadImprovements(cwd), indexEntries: loadIndexStatus(cwd).entries,
    });
    queue = built.queue;
    report.warnings.push(...built.warnings);
    const selectedAtStart = queue.filter(e => e.status === 'selected').length;

    // 3a. New pages, generated as one batch.
    const keywordEntries = new Map(queue.filter(e => e.type === 'new_page' && e.status === 'selected').map(e => [e.keyword, e]));
    const toGenerate = [...keywordEntries.keys()];
    if (due.length === 0) {
      // An empty backlog is the normal state once a topic space is covered. The
      // week is better spent on the pages that already rank and get no clicks
      // than on a keyword invented to fill the slot.
      console.log(chalk.gray('\nNo keywords to generate — switching to improving an existing page.'));
    }
    if (toGenerate.length > 0) {
      console.log(chalk.bold(`\nGenerating ${toGenerate.length} page(s):\n`));

      const GENERATE_CONCURRENCY = 2;
      const limit = pLimit(GENERATE_CONCURRENCY);
      const generatedKeysAtomic = new Set();
      const acceptedPages = [];
      const tasks = [];
      for (const kw of toGenerate) {
        for (const locale of locales) {
          tasks.push(limit(async () => {
            const pages = await generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeysAtomic, catalog, acceptedPages);
            for (const page of pages) {
              generatedKeysAtomic.add(`${page.slug}::${page.locale}`);
              generatedPages.push(page);
              kw.status = KEYWORD_STATUS.PR_OPENED;
              kw.queue = predictedOf(whyOf(keywordEntries.get(kw)));
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

    // 3b. Everything else, one entry after the other in rank order. Before each one its pages are checked
    // against the files already prepared (inbound-link edits included): a sibling PR branches from the same
    // checkout. An entry that yields nothing lets the next one the cap deferred move up.
    const generatedCount = () => new Set(generatedPages.map(p => p.keyword)).size;
    const openedBefore = executed.filter(e => e.status === 'opened').length;
    const used = () => openedBefore + generatedCount() + preparedList.length;
    const prepareEntry = async (entry, skip) => {
      const common = { config, dryRun, catalog, skipOverlays: catalogDown, skip };
      if (entry.type === 'merge') return prepareImprove({ ...common, skipOverlays: true, slug: entry.pick.slug, mergeFrom: [entry.pick.from], mergeAlert: entry.pick.alert_id }, cwd);
      if (entry.type === 'prune') return preparePrune(entry.pick, { config, cwd });
      return prepareImprove({ ...common, pick: entry.pick }, cwd);
    };
    const runEntry = async (entry) => {
      const taken = touchedSlugs(preparedList);
      if (entry.touches.some(t => taken.includes(t))) { Object.assign(entry, { status: 'deferred', reason: 'overlap' }); return; }
      Object.assign(entry, { status: 'selected', reason: null });
      try {
        const prepared = await prepareEntry(entry, taken);
        if (!prepared) { Object.assign(entry, { status: 'deferred', reason: 'not_prepared' }); return; }
        Object.assign(prepared, { auto: !DRAFT_TYPES.has(entry.type), why: whyOf(entry), queue: predictedOf(whyOf(entry)) });
        preparedList.push(prepared);
        entryOf.set(prepared, entry);
      } catch (e) {
        // The generated pages must still get their PRs.
        rethrowIfBudget(e);
        const warning = failureWarning(entry, e);
        console.log(chalk.yellow(`\n${warning}`));
        report.warnings.push(warning);
        Object.assign(entry, { status: 'deferred', reason: 'failed' });
      }
    };
    if (!dryRun) {
      for (const entry of queue.filter(e => e.status === 'selected' && e.type !== 'new_page')) await runEntry(entry);
      for (const entry of nextInLine(queue.filter(e => e.type !== 'new_page'), Infinity)) {
        if (used() >= maxPrs) break;
        await runEntry(entry);
      }
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
        // Sibling PRs branch from one checkout: the seasonal PR's files must not be edited by the new pages' inbound-link edits too.
        const exclude = touchedSlugs(preparedList);
        const created = await createPRs({ generatedPages, keywordsData, config, cwd, exclude });
        report.prs.push(...created.prs.map(p => ({ url: p.url, kind: 'new', slug: p.slug })));
        report.warnings.push(...created.warnings);
        report.errors.push(...created.errors);
        for (const p of created.prs) {
          const entry = queue.find(e => e.type === 'new_page' && e.slug === p.slug);
          if (entry) entry.status = 'opened';
        }
      }
      for (const prepared of preparedList) {
        try {
          const url = await publishImprove(prepared, { config, cwd, warnings: report.warnings });
          if (url) {
            entryOf.get(prepared).status = 'opened';
            report.prs.push({ url, slug: prepared.slug, ...prKind(prepared), ...(prepared.auto === false ? { held: true } : {}) });
            if (prepared.season) refreshedSlug = prepared.slug;
          }
        } catch (e) {
          console.error(chalk.red(`\nImprove PR failed: ${e.message}`));
          report.errors.push(`Improve PR failed for ${prepared.slug}: ${e.message}`);
        }
      }
      // What was selected but did not end in a PR is left for the next run.
      for (const entry of queue.filter(e => e.status === 'selected')) Object.assign(entry, { status: 'deferred', reason: 'not_opened' });
      if (selectedAtStart > 0 && report.prs.length === 0) {
        report.warnings.push(`The queue selected ${selectedAtStart} action(s), but no PR was opened`);
      }

      // 6. Track
      console.log('');
      await track(config, cwd);
    }

    // The mail reports what happens with each assessment instead of handing out its actions.
    if (report.assessments?.length) {
      try {
        annotateFollowups({ assessments: report.assessments, config, cwd, prs: report.prs });
      } catch (e) {
        report.warnings.push(`Assessment follow-up unknown: ${e.message}`);
      }
    }

    const seasons = activeSeasons(config.seasons);
    if (seasons.length > 0) {
      const had = new Set(keywordsBefore.keywords.map(k => k.keyword));
      report.seasons = seasons.map(({ name, peak }) => ({
        name,
        peak,
        seeded: keywordsData.keywords.filter(k => k.season === name && !had.has(k.keyword) && k.status !== KEYWORD_STATUS.SKIP).length,
        refreshed: preparedList.some(p => p.season === name) ? refreshedSlug : null,
      }));
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
    if (queue) report.queue = reportQueue(queue);
    if (!dryRun) {
      if (queue) {
        try { saveQueue(queue, cwd); } catch (e) { report.warnings.push(`Queue not written: ${e.message}`); }
      }
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
