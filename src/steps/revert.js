import { basename, dirname, join } from 'path';
import chalk from 'chalk';
import { format } from '../lib/date.js';
import { isStrict, defaultLocale } from '../lib/config.js';
import { loadChanges, saveChanges } from '../lib/changes.js';
import { loadImprovements, saveImprovements, parseOverlayKey } from '../lib/improvements.js';
import { strictValidateOpts } from '../lib/landings.js';
import { contractOptions } from '../lib/catalog.js';
import { validate } from './validate.js';
import * as github from '../lib/github.js';

/**
 * Etappe C: a rewrite that measured worse than its control pages after 28 and 56 days
 * (`revert_candidate` in the change ledger) is taken back. The page files the rewrite PR
 * changed (the page and its counterpart, never other pages' link edits) go back to their
 * content before the merge, in one PR on `seo/revert/<slug>` that the gate merges like any
 * rewrite. Only when nothing touched those files since the merge; a PR that deleted or
 * renamed files (a merge of pages) is never reverted automatically.
 *
 * The outcome is stored on the ledger entry as `revert: { status, date, pr_url?, reason? }`
 * (`opened`, `skipped`, `superseded`), so a decided case is not looked at again. Reasons that
 * can change (an open rewrite PR of the page, a GitHub error) leave no mark and retry next run.
 * An opened revert also goes into improvements.json with `revert: true`: the page sits out the
 * normal cooldown, and once merged the ledger measures it as kind `revert`, which is never
 * itself a revert candidate (no flip-flop).
 */

const lastSegment = (url) => String(url).split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();

/** Page names (file basenames without .md) a ledger entry stands for: the page and its counterpart. */
export function pageNames(entry) {
  const names = new Set((entry.urls || []).map(lastSegment).filter(Boolean));
  const overlay = parseOverlayKey(entry.slug);
  names.add(overlay ? overlay.id : entry.slug);
  return names;
}

/**
 * Ledger entries that are due for a revert decision, each with `skip` when it is settled
 * without GitHub: `superseded` (the page was rewritten again after this one merged).
 * `wait` marks an entry whose page has an open rewrite PR (decided on a later run).
 */
export function revertCandidates({ changes, improvements }) {
  const out = [];
  for (const entry of changes.entries || []) {
    if (entry.kind !== 'rewrite' || !entry.revert_candidate || entry.revert) continue;
    const later = (improvements.entries || []).filter(e => e.slug === entry.slug && !e.failed && e.pr_url !== entry.pr_url && e.date > entry.merged_at);
    if (later.some(e => e.merged_at)) out.push({ entry, skip: 'superseded' });
    else if (later.some(e => e.pr_url && !e.merged_at)) out.push({ entry, wait: 'open_rewrite' });
    else out.push({ entry });
  }
  return out;
}

/** Files to restore from a merged rewrite PR, or `{ skip }` when the PR must not be reverted automatically. */
export function filesToRestore(entry, prFiles) {
  if (prFiles.some(f => f.status === 'removed' || f.status === 'renamed')) return { skip: 'deletes_or_moves_pages' };
  const names = pageNames(entry);
  const paths = prFiles.filter(f => f.status === 'modified' && f.path.endsWith('.md') && names.has(basename(f.path, '.md'))).map(f => f.path);
  return paths.length ? { paths } : { skip: 'no_page_files' };
}

// The same rules `seo check` applies in the gate, so a revert that would fail there is never opened.
function checkOldVersion({ config, cwd, path, markdown }) {
  if (config.catalog_url || (config.overlays && /\/(products|categories)\//.test(path))) return [];
  const slug = basename(path, '.md');
  const keyword = { keyword: slug.replace(/-/g, ' '), expected_entities: [] };
  const opts = {
    ...strictValidateOpts({}, join(cwd, dirname(path)), [slug], isStrict(config)),
    ...contractOptions(config, null, cwd, defaultLocale(config)),
  };
  return validate(markdown, keyword, opts).errors;
}

function prBody(entry, paths) {
  const r = entry.readings || {};
  const fmt = (x) => x ? `${x.verdict}, effect ${Number(x.effect).toFixed(2)} on ${x.metric} (${x.window?.startDate} to ${x.window?.endDate})` : 'n/a';
  return [
    `The rewrite ${entry.pr_url} (merged ${entry.merged_at}) measured worse than its control pages twice:`,
    '',
    `- after 28 days: ${fmt(r.d28)}`,
    `- after 56 days: ${fmt(r.d56)}`,
    '',
    'This PR restores the page to its version before that merge. Nothing changed these files since.',
    '',
    ...paths.map(p => `- \`${p}\``),
    '',
    'Opened automatically by `seo run` (revert of a measured rewrite).',
  ].join('\n');
}

/**
 * Opens one revert PR per due ledger entry. Returns `[{ slug, status, pr_url?, reason? }]`
 * for the report. Never throws for a single page; GitHub errors become warnings.
 * `gh` and `check` are injectable for tests.
 */
export async function revertWorseRewrites({ config, cwd = process.cwd(), dryRun = false, warnings = [], today = format(new Date()), gh = github, check = checkOldVersion }) {
  if (config.auto_revert === false) return [];
  let changes;
  try {
    changes = loadChanges(cwd);
  } catch (e) {
    warnings.push(`Revert skipped: ${e.message}`);
    return [];
  }
  const improvements = loadImprovements(cwd);
  const results = [];
  let changesDirty = false;
  let improvementsDirty = false;
  const decide = (entry, revert) => { entry.revert = { ...revert, date: today }; changesDirty = true; };

  for (const { entry, skip, wait } of revertCandidates({ changes, improvements })) {
    if (wait) continue;
    if (skip) {
      if (!dryRun) decide(entry, { status: 'superseded' });
      results.push({ slug: entry.slug, status: 'superseded' });
      continue;
    }
    try {
      const pr = await gh.getMergedPRChanges({ repo: config.repo, url: entry.pr_url });
      if (!pr) throw new Error('PR is not merged');
      const plan = filesToRestore(entry, pr.files);
      if (plan.skip) {
        if (!dryRun) decide(entry, { status: 'skipped', reason: plan.skip });
        results.push({ slug: entry.slug, status: 'skipped', reason: plan.skip });
        continue;
      }
      const base = await gh.getDefaultBranch({ repo: config.repo });
      const files = [];
      let reason = null;
      for (const path of plan.paths) {
        const [now, merged, before] = await Promise.all([
          gh.getFileAt({ repo: config.repo, path, ref: base }),
          gh.getFileAt({ repo: config.repo, path, ref: pr.mergeSha }),
          gh.getFileAt({ repo: config.repo, path, ref: pr.parentSha }),
        ]);
        if (!now || !merged || now.sha !== merged.sha) { reason = 'changed_since'; break; }
        if (!before) { reason = 'no_previous_version'; break; }
        const errors = check({ config, cwd, path, markdown: before.content });
        if (errors.length) { reason = 'previous_version_fails_check'; warnings.push(`Revert of ${entry.slug}: ${path} before the rewrite fails seo check (${errors[0]})`); break; }
        files.push({ path, content: before.content });
      }
      if (reason) {
        if (!dryRun) decide(entry, { status: 'skipped', reason });
        results.push({ slug: entry.slug, status: 'skipped', reason });
        continue;
      }
      if (dryRun) {
        console.log(chalk.gray(`  [dry run] would revert ${entry.slug}: ${files.map(f => f.path).join(', ')}`));
        results.push({ slug: entry.slug, status: 'planned' });
        continue;
      }
      const branch = `seo/revert/${entry.slug.replace(':', '-')}`;
      try {
        await gh.createBranchAndCommit({ files, message: `seo: revert rewrite of ${entry.slug} (measured worse)`, repo: config.repo, baseBranch: base, branch });
      } catch (e) {
        if (e.code === 'BRANCH_EXISTS') { warnings.push(`Revert of ${entry.slug} skipped: branch ${branch} already exists`); continue; }
        throw e;
      }
      let url;
      try {
        url = await gh.openPR({ repo: config.repo, branch, title: `seo: revert rewrite of ${entry.slug}`, body: prBody(entry, plan.paths), baseBranch: base });
      } catch (e) {
        try { await gh.deleteBranch({ repo: config.repo, branch }); } catch { /* the reconcile step drops orphans too */ }
        throw e;
      }
      decide(entry, { status: 'opened', pr_url: url });
      improvements.entries.push({ slug: entry.slug, date: today, queries: [], pr_url: url, revert: true });
      improvementsDirty = true;
      results.push({ slug: entry.slug, status: 'opened', pr_url: url });
      console.log(chalk.green(`  Revert PR for ${entry.slug}: ${url}`));
    } catch (e) {
      warnings.push(`Revert of ${entry.slug} failed: ${e.message}`);
    }
  }

  if (changesDirty) {
    try { saveChanges(changes, cwd); } catch (e) { warnings.push(`Change ledger not saved after revert: ${e.message}`); }
  }
  if (improvementsDirty) saveImprovements(improvements, cwd);
  return results;
}
