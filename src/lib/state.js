import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { KEYWORDS_FILE, SITEMAP_PENDING_FILE } from './keywords.js';
import { IMPROVEMENTS_FILE } from './improvements.js';
import { INDEX_STATUS_FILE } from './index-status.js';
import { BUDGET_FILE } from './budget.js';
import { commitToBranch, getBlobShas } from './github.js';

// Machine state that goes straight to main, never into a content PR.
export const STATE_FILES = [KEYWORDS_FILE, SITEMAP_PENDING_FILE, IMPROVEMENTS_FILE, INDEX_STATUS_FILE, BUDGET_FILE];

// Git object id of a file: sha1("blob <bytes>\0<content>").
export function gitBlobSha(content) {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/**
 * Commits the state files whose content differs from main to main. [skip ci]
 * because raaaf/portfolio-2025 deploys to FTP on every unfiltered push, and a
 * bookkeeping snapshot must not redeploy the site. Returns the committed paths
 * (empty when nothing differs, then no commit is made).
 */
export async function commitState({ cwd, repo, reason }) {
  const local = STATE_FILES
    .filter(path => existsSync(join(cwd, path)))
    .map(path => ({ path, content: readFileSync(join(cwd, path), 'utf8') }));

  const remote = await getBlobShas({ repo, branch: 'main' });
  const changed = local.filter(f => remote[f.path] !== gitBlobSha(f.content));
  if (changed.length === 0) return [];

  await commitToBranch({ files: changed, message: `seo: state (${reason}) [skip ci]`, repo, branch: 'main' });
  return changed.map(f => f.path);
}
