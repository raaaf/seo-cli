import { Octokit } from '@octokit/rest';
import { isoWeek } from './date.js';

// One client per owner. A fine-grained GitHub token is scoped to exactly one
// owner, and this CLI writes to repos under more than one, so a single
// GITHUB_TOKEN can no longer cover every target. Per owner we look for
// GITHUB_TOKEN_<OWNER> first and fall back to GITHUB_TOKEN, which keeps a
// classic token (and the test setup) working unchanged.
const octokits = {};
function envKeyFor(owner) {
  return `GITHUB_TOKEN_${String(owner).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
function getOctokit(owner) {
  const key = envKeyFor(owner);
  const token = process.env[key] || process.env.GITHUB_TOKEN;
  if (!token) throw new Error(`${key} not set (and no GITHUB_TOKEN fallback)`);
  if (!octokits[token]) octokits[token] = new Octokit({ auth: token });
  return octokits[token];
}

export async function openPR({ repo, branch, title, body, baseBranch = 'main' }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);

  const res = await octokit.pulls.create({
    owner,
    repo: name,
    title,
    body,
    head: branch,
    base: baseBranch,
  });

  return res.data.html_url;
}

// Current state of a PR, by number or by html url: 'open', 'merged' or 'closed'
// (closed without merge). Used to reconcile keyword and improvement status.
export async function getPR({ repo, number, url }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);
  const pullNumber = number ?? Number(String(url).match(/\/pull\/(\d+)\/?$/)?.[1]);
  if (!Number.isInteger(pullNumber)) throw new Error(`Not a pull request reference: ${url ?? number}`);

  const { data } = await octokit.pulls.get({ owner, repo: name, pull_number: pullNumber });
  const state = data.merged ? 'merged' : data.state === 'open' ? 'open' : 'closed';
  return { state, mergedAt: data.merged_at ?? null, headRef: data.head?.ref ?? null };
}

// Removes a branch. An already deleted one (404) is fine: the goal is that the
// name is free again, so BRANCH_EXISTS cannot block the next run.
export async function deleteBranch({ repo, branch }) {
  const [owner, name] = repo.split('/');
  try {
    await getOctokit(owner).git.deleteRef({ owner, repo: name, ref: `heads/${branch}` });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

// Blobs, tree and commit on top of parentSha. Shared by the branch-creating and
// the branch-advancing commit paths.
async function buildCommit(octokit, { owner, name, files, message, parentSha }) {
  const { data: parent } = await octokit.git.getCommit({ owner, repo: name, commit_sha: parentSha });

  const treeItems = await Promise.all(files.map(async ({ path, content }) => {
    const { data: blob } = await octokit.git.createBlob({
      owner, repo: name,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  const { data: tree } = await octokit.git.createTree({
    owner, repo: name,
    base_tree: parent.tree.sha,
    tree: treeItems,
  });

  const { data: commit } = await octokit.git.createCommit({
    owner, repo: name,
    message,
    tree: tree.sha,
    parents: [parentSha],
  });
  return commit.sha;
}

// Creates a new branch off baseBranch. Never overwrites: an existing branch
// throws with code BRANCH_EXISTS so the caller can skip instead of clobbering
// an open PR's history.
export async function createBranchAndCommit({ files, message, cwd: _cwd, repo, baseBranch = 'main', branch = `seo/${isoWeek()}` }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);

  const { data: ref } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${baseBranch}` });
  const sha = await buildCommit(octokit, { owner, name, files, message, parentSha: ref.object.sha });

  try {
    await octokit.git.createRef({ owner, repo: name, ref: `refs/heads/${branch}`, sha });
  } catch (e) {
    if (e.status === 422) {
      throw Object.assign(new Error(`Branch ${branch} already exists`), { code: 'BRANCH_EXISTS', cause: e });
    }
    throw e;
  }

  return branch;
}

const COMMIT_ATTEMPTS = 3;

// Adds one commit on top of the current head of an existing branch. The ref
// update is never forced: a 422 means the head moved (someone pushed in
// between), so the head is read again and the commit rebuilt on top of it.
export async function commitToBranch({ files, message, repo, branch = 'main' }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);

  for (let attempt = 1; ; attempt++) {
    const { data: ref } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
    const sha = await buildCommit(octokit, { owner, name, files, message, parentSha: ref.object.sha });
    try {
      await octokit.git.updateRef({ owner, repo: name, ref: `heads/${branch}`, sha, force: false });
      return sha;
    } catch (e) {
      if (e.status !== 422) throw e;
      if (attempt >= COMMIT_ATTEMPTS) {
        throw new Error(`Could not update ${branch} after ${COMMIT_ATTEMPTS} attempts (head kept moving)`, { cause: e });
      }
    }
  }
}

// Git blob SHA per file path at the head of a branch, from the remote tree.
export async function getBlobShas({ repo, branch = 'main' }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);

  const { data: ref } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${branch}` });
  const { data: commit } = await octokit.git.getCommit({ owner, repo: name, commit_sha: ref.object.sha });
  const { data: tree } = await octokit.git.getTree({ owner, repo: name, tree_sha: commit.tree.sha, recursive: 'true' });
  if (tree.truncated) throw new Error(`Git tree of ${repo}@${branch} is truncated (too many files); cannot compare blob SHAs`);
  return Object.fromEntries(tree.tree.filter(t => t.type === 'blob').map(t => [t.path, t.sha]));
}
