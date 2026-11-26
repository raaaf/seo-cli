import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import chalk from 'chalk';
import { loadConfig, defaultLocale, localeLandingPath } from '../lib/config.js';
import { strictValidateOpts, buildMergeFiles, readLandingPages, tryInboundLinkFiles, inboundLinksSection } from '../lib/landings.js';
import { inboundLinks, MIN_INBOUND_LINKS } from '../lib/inbound-links.js';
import { createBranchAndCommit, openPR, deleteBranch } from '../lib/github.js';
import { commitState } from '../lib/state.js';
import { whyBlock } from '../lib/queue.js';
import { writeReport, writeRunLog, llmSummary, budgetSummary } from '../lib/runlog.js';
import { isoWeek, format } from '../lib/date.js';
import { loadAlerts, saveAlerts } from '../lib/watch.js';
import { loadImprovements, saveImprovements, recordImprovement, slugsInCooldown, parseOverlayKey } from '../lib/improvements.js';
import { fetchPagePerformance, selectPage, improvePage, keywordFor, targetedPage } from '../steps/improve.js';
import { validate } from '../steps/validate.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { linkAlternates } from '../steps/counterpart.js';
import { generateValidatedCounterpart } from '../steps/counterpart-loop.js';
import { prepareOverlay } from '../steps/overlay.js';
import { snippetPage } from '../steps/snippet.js';
import { answerQuestions } from '../steps/questions.js';
import { loadCatalog, contractOptions } from '../lib/catalog.js';
import { rybbitActive, rybbitReport } from '../lib/signals/rybbit.js';
import { pickSeasonPage } from '../lib/seasons.js';
import { pickAssessedPage, assessmentDiagnosis, PRUNE_REWRITES, PRUNE_WAIT_DAYS } from '../lib/assessed-rewrite.js';

/**
 * Selects the one existing page with the strongest case (or takes the one named
 * by `opts.slug`, optionally merging `opts.mergeFrom` into it), rewrites it, validates
 * and fact-checks it. Commits nothing and records no cooldown: that happens in
 * publishImprove, once the PR exists. `opts.pick` is a pick the queue of `seo run` already made
 * (`{ kind: 'season' | 'stale' | 'assessed' | 'gsc' | 'snippet' | 'faq' | 'overlay', ... }`, see steps/queue.js):
 * nothing is selected then. `opts.skip` names pages a sibling PR of the same run touches: neither
 * picked nor edited for inbound links.
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

  if (!opts.slug && (opts.mergeFrom?.length || opts.brief)) throw new Error('--merge-from and --brief need --slug');

  // Overlays also need the performance rows, so they are fetched outside the targeted path.
  let rows = null;
  const targeted = Boolean(opts.slug);
  // A pick of the run queue replaces the selection below, which only `seo improve` itself still runs.
  const pick = opts.pick ?? null;
  const selecting = !targeted && !pick;
  // A page listed under an active season beats the Search Console pick; it needs no GSC rows.
  const seasonal = pick?.kind === 'season' ? pick : selecting ? pickSeasonPage({ config, cwd }) : null;
  // Next: a page Google skips although it is technically fine, rewritten along its content assessment.
  const assessed = pick?.kind === 'assessed' ? pick : selecting && !seasonal ? pickAssessedPage({ config, cwd, skip: opts.skip ?? [] }) : null;
  // A recipe page keeps its text in an overlay file: the assessment becomes the overlay's brief.
  if (assessed && parseOverlayKey(assessed.slug)) {
    return prepareOverlay({
      config, cwd, dryRun,
      target: {
        slug: assessed.slug, queries: [], impressions: 0, clicks: 0, bestPosition: null,
        reason: `Index-Bewertung: Google zeigt die Seite nicht (${assessed.assessment.assessed_at})`,
        diagnosis: assessmentDiagnosis(assessed.assessment),
        assessed: assessed.alert_id,
      },
    });
  }
  if (pick?.kind === 'overlay') {
    return prepareOverlay({ config, cwd, rows: pick.rows, catalog: opts.catalog ?? null, dryRun });
  }
  if (selecting && !seasonal && !assessed) {
    try {
      rows = await fetchPagePerformance(config);
    } catch (e) {
      console.log(chalk.yellow(`  Search Console unavailable: ${e.message}`));
      return null;
    }
  }

  // Shop projects: the catalog backs the page contract. Unreachable means no overlay and no product check.
  let catalog = opts.catalog ?? null;
  if (!catalog && config.catalog_url) {
    try {
      catalog = await loadCatalog(config);
    } catch (e) {
      console.log(chalk.yellow(`  ${e.message}`));
    }
  }

  let page;
  if (targeted) {
    const brief = opts.brief ? readFileSync(join(cwd, opts.brief), 'utf8') : null;
    page = targetedPage({ slug: opts.slug, mergeFrom: opts.mergeFrom ?? [], brief }, config, cwd);
  } else if (seasonal) {
    const reason = `Saison ${seasonal.season}, Peak ${seasonal.peak}`;
    page = {
      ...targetedPage({ slug: seasonal.slug }, config, cwd),
      reason,
      diagnosis: `Seasonal refresh ahead of the peak on ${seasonal.peak} (${seasonal.season}). Bring the page up to date for the coming season: dates, deadlines, checklists and examples.`,
      season: seasonal.season,
      peak: seasonal.peak,
    };
  } else if (pick?.kind === 'stale') {
    page = {
      ...targetedPage({ slug: pick.slug }, config, cwd),
      reason: `Veraltet: ${pick.reason}`,
      diagnosis: 'Bring facts, year references and prices up to date, keep the structure. Replace outdated years, figures, dates and deadlines with current ones, and drop what cannot be verified.',
      stale: true,
    };
  } else if (pick?.page) {
    page = pick.page;
  } else if (assessed) {
    page = {
      ...targetedPage({ slug: assessed.slug }, config, cwd),
      reason: `Index-Bewertung: Google zeigt die Seite nicht (${assessed.assessment.assessed_at})`,
      diagnosis: assessmentDiagnosis(assessed.assessment),
      assessed: assessed.alert_id,
    };
  } else {
    page = selectPage({ rows, config, cwd, cooldown: slugsInCooldown(loadImprovements(cwd)), engagement: await loadEngagement(config, cwd, dryRun) });
  }

  if (!page) {
    console.log(chalk.gray('  No page qualifies: not enough impressions, or everything eligible was rewritten recently.'));
    // Nothing to rewrite on a landing page: an overlay (shop meta and intro) takes the slot.
    if (config.overlays && !opts.skipOverlays) return prepareOverlay({ config, cwd, rows, catalog, dryRun });
    return null;
  }

  const before = readMeta(page.slug, config, cwd);
  const keywordLike = keywordFor(page);
  const validateOpts = {
    ...strictValidateOpts(config, join(cwd, localeLandingPath(config, defaultLocale(config))), [page.slug, ...(page.mergeFrom ?? [])]),
    ...contractOptions(config, catalog, cwd, defaultLocale(config)),
  };

  if (pick?.kind === 'snippet') return prepareSnippet(page, { config, cwd, dryRun, validateOpts });
  if (pick?.kind === 'faq') return prepareFaq(page, { config, cwd, dryRun, validateOpts });

  // Two attempts, same as generate. A rewrite costs a full Opus call, and a
  // single hard error (one word over the tldr limit) is not worth losing it.
  let filePath, markdown, result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    ({ filePath, markdown } = await improvePage(page, config, cwd, attempt > 1 ? result : null, validateOpts));
    result = validate(markdown, keywordLike, validateOpts);
    if (result.ok) break;
  }

  if (!result.ok) {
    console.log(chalk.red(`  Improvement discarded: the rewrite of ${page.slug} does not validate after 2 attempts`));
    result.errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    if (holdsOnFailure(page) && !dryRun) recordFailure(page.slug, cwd);
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
      if (holdsOnFailure(page)) recordFailure(page.slug, cwd);
      return null;
    }
    if (reviewed !== markdown && validate(reviewed, keywordLike, validateOpts).ok) finalMarkdown = reviewed;
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
  const mergeFrom = page.mergeFrom ?? [];
  const merge = mergeFrom.length ? buildMergeFiles({ survivor: page.slug, mergeFrom, config, cwd }) : null;
  const files = [
    { path: filePath, content: finalMarkdown },
    ...(counterpart?.markdown ? [{ path: counterpart.filePath, content: counterpart.markdown }] : []),
    ...(merge ? merge.files : []),
  ];
  const inbound = await inboundLinkEdits({ slug: page.slug, markdown: finalMarkdown, files, config, cwd, exclude: opts.skip ?? [] });
  return {
    slug: page.slug,
    ...(page.season ? { season: page.season, peak: page.peak } : {}),
    ...(page.assessed ? { assessed: page.assessed } : {}),
    ...(opts.mergeAlert ? { mergeAlert: opts.mergeAlert, mergeFrom, auto: false } : {}),
    ...(holdsOnFailure(page) ? { holdOnFailure: true } : {}),
    files: [...files, ...inbound.files],
    record: { slug: page.slug, queries: page.queries.map(q => q.query) },
    commitMessage: `seo: improve ${page.slug} (${week})\n\n${page.reason}`,
    prTitle: opts.mergeAlert ? `SEO: merge ${mergeFrom.join(', ')} into ${page.slug} (${week})` : `SEO: improve ${page.slug} (${week})`,
    prBody: (opts.mergeAlert ? mergeProposalNote(page.slug, mergeFrom) : '') + buildBody(page, before, readMetaFrom(finalMarkdown), {
      factCheckError,
      factChecked: config.fact_check !== false,
      warnings: validate(finalMarkdown, keywordLike, validateOpts).warnings,
      counterpart,
      merged: merge,
      newLinks: inbound.links,
    }),
  };
}

// A snippet test: only the meta title and description of a page that ranks on page one and is not clicked.
// The PR merges by itself, the page text is byte for byte the one on disk.
async function prepareSnippet(page, { config, cwd, dryRun, validateOpts }) {
  const result = await snippetPage(page, config, cwd, validateOpts);
  if (result.failure) {
    console.log(chalk.red(`  Snippet test discarded: the new title or description of ${page.slug} does not validate after 2 attempts`));
    result.failure.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    if (!dryRun) recordFailure(page.slug, cwd);
    return null;
  }
  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${page.slug} ---\n`));
    console.log(`${result.after.title}\n${result.after.description}`);
    return null;
  }
  const week = isoWeek();
  const note = 'Snippet-Test: nur Titel und Description geändert, der Text der Seite ist unverändert.\n\n';
  return {
    slug: page.slug,
    branch: `seo/snippet/${page.slug}`,
    snippet: true,
    holdOnFailure: true,
    files: [{ path: result.filePath, content: result.markdown }],
    record: { slug: page.slug, queries: page.queries.map(q => q.query), snippet: true },
    commitMessage: `seo: snippet test ${page.slug} (${week})\n\n${page.reason}`,
    prTitle: `SEO: snippet test ${page.slug} (${week})`,
    prBody: note + buildBody(page, result.before, result.after, { factChecked: false, warnings: result.warnings }),
  };
}

// FAQ answers: question and purchase searches the page loses the click on, answered as FAQ entries from
// what the site already states. Only the `faq:` list changes (and the counterpart's at the same index).
// Fact-checked like a rewrite; merges through the gate like a snippet test.
async function prepareFaq(page, { config, cwd, dryRun, validateOpts }) {
  const result = await answerQuestions(page, config, cwd, validateOpts);
  if (result.failure) {
    console.log(chalk.red(`  FAQ answers discarded: the entries for ${page.slug} do not validate after 2 attempts`));
    result.failure.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    if (!dryRun) recordFailure(page.slug, cwd);
    return null;
  }
  if (result.none) {
    console.log(chalk.gray(`  No FAQ answer for ${page.slug}: ${result.skipped.map(s => `"${s.query}" (${s.reason})`).join(', ') || 'every query skipped'}`));
    if (!dryRun) recordFailure(page.slug, cwd);
    return null;
  }
  const keywordLike = keywordFor(page);
  let markdown = result.markdown;
  if (config.fact_check !== false && !dryRun) {
    const { markdown: reviewed, findings, unchecked } = await reviewPage(markdown, keywordLike, config, cwd);
    const faqOf = (md) => JSON.stringify(parseFrontmatter(md).parsed?.faq ?? null);
    // An answer the fact check could not confirm is not shipped: there is no human between this PR and the site.
    if (unchecked || unresolvedSeverity(findings) === 'high' || (result.counterpart && faqOf(reviewed) !== faqOf(markdown))) {
      console.log(chalk.red(`  FAQ answers discarded: the fact check of ${page.slug} ${unchecked ? 'did not run' : 'found an error'}`));
      recordFailure(page.slug, cwd);
      return null;
    }
    if (reviewed !== markdown && validate(reviewed, keywordLike, validateOpts).ok) markdown = reviewed;
  }
  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${page.slug} (FAQ) ---\n`));
    for (const e of result.entries) console.log(`${e.replaces >= 0 ? `[ersetzt ${e.replaces}] ` : ''}${e.q}\n${e.a}\n  (${e.queries.join(', ')})\n`);
    for (const s of result.skipped) console.log(chalk.gray(`  übersprungen: "${s.query}" (${s.reason})`));
    return null;
  }
  const week = isoWeek();
  const list = (rows) => rows.map(r => `- ${r}`).join('\n');
  const body = [
    'FAQ-Antworten: Fragen und Kaufabsicht-Suchen, für die die Seite in Google erscheint und zu wenig Klicks bekommt, als FAQ-Einträge beantwortet. Nur die FAQ-Liste ist geändert, der übrige Text ist unverändert.',
    '',
    '## Neue Einträge',
    '',
    ...result.entries.flatMap(e => [`**${e.q}**${e.replaces >= 0 ? ` (ersetzt Eintrag ${e.replaces + 1})` : ''}`, '', e.a, '', `Suchanfragen: ${e.queries.map(q => `\`${q}\``).join(', ')}`, '']),
    ...(result.counterpart ? [`Gegenstück \`${result.counterpart.slug}\` hat dieselben Einträge an derselben Stelle.`, ''] : []),
    '## Suchanfragen',
    '',
    '| Suchanfrage | Art | Position | Impressionen | Klicks |',
    '|---|---|---|---|---|',
    ...page.questions.map(q => `| ${q.query} | ${q.kind === 'question' ? 'Frage' : 'Kaufabsicht'} | ${q.position.toFixed(1)} | ${q.impressions} | ${q.clicks} |`),
    '',
    ...(result.skipped.length ? ['## Nicht beantwortet', '', list(result.skipped.map(s => `\`${s.query}\`: ${s.reason}`)), ''] : []),
    ...(result.warnings.length ? ['## Warnungen', '', list(result.warnings), ''] : []),
  ].join('\n');
  return {
    slug: page.slug,
    branch: `seo/faq/${page.slug}`,
    faq: true,
    holdOnFailure: true,
    files: [{ path: result.filePath, content: markdown }, ...(result.counterpart ? [{ path: result.counterpart.filePath, content: result.counterpart.markdown }] : [])],
    record: { slug: page.slug, queries: page.questions.map(q => q.query), faq: true },
    commitMessage: `seo: faq answers ${page.slug} (${week})\n\n${page.reason}`,
    prTitle: `SEO: FAQ-Antworten ${page.slug} (${week})`,
    prBody: body,
  };
}

// Top of an automatic merge PR: it deletes and redirects live pages, so it waits for the owner.
function mergeProposalNote(slug, mergeFrom) {
  const pages = mergeFrom.map(n => `/${n}`).join(', ');
  return `> **Wartet auf dein Okay.** Google zeigt ${pages} trotz Überarbeitung nicht in der Suche, und die Index-Bewertung nennt /${slug} als Seite mit demselben Thema. Dieser PR legt beide zusammen: ${pages} wird gelöscht und auf /${slug} weitergeleitet. Er bleibt als Entwurf offen, bis du zustimmst; schließt du ihn, wird diese Bewertung nicht noch einmal vorgeschlagen.\n\n`;
}

// A seasonal, stale, assessed or Search Console pick that ends without a PR takes the normal cooldown (a
// `failed` entry, as overlays do), so the same page does not cost a rewrite every week. It does not count
// as a refresh for the 300-day rule. A targeted rewrite (`--slug`) was asked for by name and does not.
const holdsOnFailure = (page) => Boolean(page.season || page.assessed || page.stale || ['snippet', 'faq', 'near_page1', 'far'].includes(page.kind));

function recordFailure(slug, cwd) {
  const improvements = recordImprovement(loadImprovements(cwd), { slug, queries: [] });
  improvements.entries.at(-1).failed = true;
  saveImprovements(improvements, cwd);
}

// A page with fewer than three inbound links from the other default-locale pages gets some, as
// `related_pages` entries of on-topic pages. Pages already in the PR (rewrite, counterpart, merge
// files) are never edited, and pages the merge deletes do not count as links. Never throws.
async function inboundLinkEdits({ slug, markdown, files, config, cwd, exclude = [] }) {
  const none = { files: [], links: [] };
  if (config.inbound_links === false) return none;
  // Pages of this PR and of a sibling PR of the same run (`exclude`) are never edited.
  const inPR = new Set([...files.map(f => basename(f.path, '.md')), ...exclude]);
  try {
    const deleted = new Set(files.filter(f => f.delete).map(f => basename(f.path, '.md')));
    const pages = readLandingPages(config, cwd).filter(p => !deleted.has(p.slug));
    const have = inboundLinks(pages).get(slug)?.size ?? 0;
    if (have >= MIN_INBOUND_LINKS) return none;
    const { meta_title: title, meta_description: description } = parseFrontmatter(markdown).parsed;
    const targets = [{ slug, title: title ?? slug, description: description ?? '', max: MIN_INBOUND_LINKS - have }];
    return await tryInboundLinkFiles({ targets, config, cwd, exclude: [...inPR] }, warning => console.log(chalk.yellow(`  ${warning}`)));
  } catch (e) {
    console.log(chalk.yellow(`  Inbound links skipped: ${e.message}`));
    return none;
  }
}

// Rybbit stats of the default-locale pages by slug, null without Rybbit or without data (GSC alone decides then).
async function loadEngagement(config, cwd, dryRun) {
  const warnings = [];
  if (!rybbitActive(config, warnings)) {
    warnings.forEach(w => console.log(chalk.yellow(`  ${w}`)));
    return null;
  }
  let result;
  try {
    result = await rybbitReport({ config, cwd, dryRun, warnings });
  } catch (e) {
    warnings.push(`Rybbit: ${String(e.message).split('\n')[0]}`);
  }
  warnings.forEach(w => console.log(chalk.yellow(`  ${w}`)));
  if (!result || result.report.error) return null;
  const { pages } = result;
  return Object.fromEntries(pages.filter(p => p.locale === defaultLocale(config)).map(p => [p.slug, p]));
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
  const branch = prepared.branch ?? `seo/improve/${prepared.slug}`;
  const held = prepared.auto === false;

  try {
    await createBranchAndCommit({ files: prepared.files, message: prepared.commitMessage, cwd, repo: config.repo, branch });
  } catch (e) {
    if (e.code !== 'BRANCH_EXISTS') throw e;
    const warning = `Improve skipped: branch ${branch} already exists (an earlier PR for ${prepared.slug} is still open)`;
    console.log(chalk.yellow(`  ${warning}`));
    warnings.push(warning);
    if (prepared.holdOnFailure) recordFailure(prepared.slug, cwd);
    return null;
  }

  let prUrl;
  try {
    // Only merges and removals of live pages (DRAFT_TYPES) are drafts, which the gate never merges, with
    // the reason for the action on top. Everything else merges through the gate. `auto` defaults to true (standalone `seo improve`).
    prUrl = await openPR({ repo: config.repo, branch, title: prepared.prTitle, body: held && prepared.why ? whyBlock(prepared.why) + prepared.prBody : prepared.prBody, draft: held });
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
  recordImprovement(improvements, { ...prepared.record, held, queue: prepared.queue });
  const entry = improvements.entries.at(-1);
  entry.pr_url = prUrl;
  if (prepared.mergeAlert) entry.merge = true;
  if (prepared.pruneAlert) Object.assign(entry, { prune: true, into: prepared.into });
  saveImprovements(improvements, cwd);

  // Each assessment proposes its merge once, whatever the owner decides.
  if (prepared.mergeAlert) markMergeProposed(prepared.mergeAlert, cwd);
  // Each alert proposes its removal once.
  if (prepared.pruneAlert) markPruneProposed(prepared.pruneAlert, cwd);

  console.log(chalk.green(`  PR opened: ${prUrl}`));
  return prUrl;
}

function markPruneProposed(alertId, cwd) {
  const state = loadAlerts(cwd, []);
  const alert = state.open.find(a => a.id === alertId);
  if (!alert) return;
  alert.prune_proposed_at = format(new Date());
  saveAlerts(state, cwd);
}

/**
 * The removal proposal for a page `pickPrunePage` chose: the page (and its counterpart) deleted
 * and redirected to `into`, `related_pages` repointed, no rewrite and no LLM call. Returns the
 * shape `publishImprove` takes, on `seo/prune/<slug>`.
 */
export function preparePrune({ slug, into, alert_id }, { config, cwd = process.cwd(), rewrites = PRUNE_REWRITES, waitDays = PRUNE_WAIT_DAYS }) {
  const week = isoWeek();
  const merge = buildMergeFiles({ survivor: into, mergeFrom: [slug], config, cwd });
  const manual = merge.counterparts.filter(c => c.manualRedirect)
    .map(c => `- Weiterleitung von \`/${merge.counterpartPrefix ? `${merge.counterpartPrefix}/` : ''}${c.slug}\` auf \`${c.to}\` von Hand anlegen.`);
  const body = [
    `> **Wartet auf dein Okay.** Google zeigt /${slug} nicht in der Suche, obwohl die Seite ${rewrites}-mal überarbeitet wurde und die letzte Überarbeitung mindestens ${waitDays} Tage live ist. Dieser PR nimmt sie heraus: /${slug} wird gelöscht und auf /${into} weitergeleitet, eine indexierte Seite mit verwandtem Thema. Er bleibt als Entwurf offen, bis du zustimmst; schließt du ihn, wird die Seite nicht noch einmal vorgeschlagen.`,
    '',
    '## Was sich ändert',
    '',
    ...merge.files.map(f => `- ${f.delete ? 'gelöscht' : 'geändert'}: \`${f.path}\``),
    ...manual,
    '',
  ].join('\n');
  return {
    slug,
    branch: `seo/prune/${slug}`,
    pruneAlert: alert_id,
    auto: false,
    into,
    files: merge.files,
    record: { slug, queries: [] },
    commitMessage: `seo: remove ${slug}, redirect to ${into} (${week})`,
    prTitle: `SEO: remove ${slug}, redirect to ${into} (${week})`,
    prBody: body,
  };
}

function markMergeProposed(alertId, cwd) {
  const state = loadAlerts(cwd, []);
  const alert = state.open.find(a => a.id === alertId);
  if (!alert?.assessment) return;
  alert.assessment.merge_proposed_at = format(new Date());
  saveAlerts(state, cwd);
}

/**
 * `seo improve`: prepare, state to main, PR, state to main again. Returns the PR
 * url, or null when nothing qualified, the rewrite was dropped or the PR skipped.
 * The run log (`last-run.json`, `runs.jsonl`) is written before the last state
 * commit, also when the PR failed; a dry run writes nothing.
 */
export async function improveCommand(opts = {}, cwd = process.cwd()) {
  const config = opts.config ?? loadConfig(cwd);
  if (opts.dryRun) {
    await prepareImprove({ ...opts, config }, cwd);
    return null;
  }

  const report = { status: 'idle', prs: [], budget: null, warnings: [], errors: [] };
  const syncState = (reason) => commitState({ cwd, repo: config.repo, reason });
  const week = isoWeek();
  let prUrl = null;
  try {
    const prepared = await prepareImprove({ ...opts, config }, cwd);
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
    // The reusable workflow's gate reads this to find the PR to gate.
    if (opts.report) writeReport(opts.report, report);
    // A failing last commit must not replace the error that ended the run.
    try {
      await syncState(`improve ${week} results`);
    } catch (e) {
      console.log(chalk.yellow(`  Final state commit failed: ${e.message}`));
    }
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

function buildBody(page, before, after, { factCheckError = null, factChecked = true, warnings = [], counterpart = null, merged = null, newLinks = [] } = {}) {
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
    ...(page.kind === 'targeted'
      ? [
        `Gezielte Überarbeitung von \`${page.slug}\`.`,
        '',
        `**Befund:** ${page.reason}`,
        ...(page.mergeFrom?.length ? ['', `Gelöscht und per \`seo/redirects.json\` umgeleitet: ${[...page.mergeFrom.map(s => [s, page.slug]), ...(merged?.counterparts ?? []).filter(c => !c.manualRedirect).map(c => [c.slug, c.to])].map(([from, to]) => `\`${from}\` → \`${to}\``).join(', ')}. Redirects greifen erst nach dem Deploy.`] : []),
        ...(merged?.counterparts ?? []).filter(c => c.manualRedirect).map(c => `Gegenstück ${c.slug} gelöscht, Redirect unter ${merged.counterpartPrefix}/${c.slug} bitte von Hand anlegen.`),
        '',
      ]
      : [
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
      ]),
    metaBlock,
    '',
    factCheckError || !factChecked
      ? 'Die Seite wurde nach der Überarbeitung erneut validiert, aber nicht faktengeprüft.'
      : 'Die Seite wurde nach der Überarbeitung erneut validiert und faktengeprüft.',
    '',
    ...(warnings.length ? [`**Validator-Warnungen, die nach der Überarbeitung bleiben:** ${warnings.join(' | ')}`, ''] : []),
    ...(newLinks.length ? [inboundLinksSection(newLinks, 'Neue interne Links auf diese Seite (related_pages)')] : []),
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}
