import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { KEYWORDS_FILE } from './keywords.js';
import { IMPROVEMENTS_FILE } from './improvements.js';
import { INDEX_STATUS_FILE } from './index-status.js';
import { BUDGET_FILE } from './budget.js';
import { CHANGES_FILE } from './changes.js';
import { LAST_RUN_FILE, RUNS_LOG_FILE } from './runlog.js';
import { ALERTS_FILE } from './watch.js';
import { SERP_SIGNALS_FILE, BING_SIGNALS_FILE, RYBBIT_SIGNALS_FILE } from './signals/store.js';
import { commitToBranch, getBlobShas, getDefaultBranch } from './github.js';

// Machine state that goes straight to the default branch, never into a content PR.
export const STATE_FILES = [KEYWORDS_FILE, IMPROVEMENTS_FILE, INDEX_STATUS_FILE, BUDGET_FILE, CHANGES_FILE, LAST_RUN_FILE, RUNS_LOG_FILE, ALERTS_FILE, SERP_SIGNALS_FILE, BING_SIGNALS_FILE, RYBBIT_SIGNALS_FILE];

// State files no longer written; commitState deletes them from the default branch.
export const RETIRED_STATE_FILES = ['seo/sitemap-pending.json'];

// Git object id of a file: sha1("blob <bytes>\0<content>").
export function gitBlobSha(content) {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/**
 * Commits the state files whose content differs from the default branch to it. [skip ci]
 * because raaaf/portfolio-2025 deploys to FTP on every unfiltered push, and a
 * bookkeeping snapshot must not redeploy the site. Returns the committed paths
 * (empty when nothing differs, then no commit is made). A full commit also deletes
 * the RETIRED_STATE_FILES still present on the branch. `files` limits the
 * candidates to a subset of STATE_FILES, so `seo watch` commits only its own.
 */
export async function commitState({ cwd, repo, reason, files = null }) {
  const local = STATE_FILES
    .filter(path => !files || files.includes(path))
    .filter(path => existsSync(join(cwd, path)))
    .map(path => ({ path, content: readFileSync(join(cwd, path), 'utf8') }));

  const branch = await getDefaultBranch({ repo });
  const remote = await getBlobShas({ repo, branch });
  const changed = local.filter(f => remote[f.path] !== gitBlobSha(f.content));
  // Only a full state commit retires files; the `seo watch` subset leaves them alone.
  const retired = files ? [] : RETIRED_STATE_FILES.filter(path => path in remote).map(path => ({ path, delete: true }));
  if (changed.length + retired.length === 0) return [];

  await commitToBranch({ files: [...changed, ...retired], message: `seo: state (${reason}) [skip ci]`, repo, branch });
  return [...changed, ...retired].map(f => f.path);
}
