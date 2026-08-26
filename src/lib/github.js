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

export async function createBranchAndCommit({ files, message, cwd: _cwd, repo, baseBranch = 'main', branch = `seo/${isoWeek()}` }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit(owner);

  // Get base branch SHA
  const { data: ref } = await octokit.git.getRef({ owner, repo: name, ref: `heads/${baseBranch}` });
  const baseSha = ref.object.sha;

  // Get base tree SHA
  const { data: baseCommit } = await octokit.git.getCommit({ owner, repo: name, commit_sha: baseSha });
  const baseTreeSha = baseCommit.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(files.map(async ({ path, content }) => {
    const { data: blob } = await octokit.git.createBlob({
      owner, repo: name,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  // Create tree
  const { data: tree } = await octokit.git.createTree({
    owner, repo: name,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create commit
  const { data: commit } = await octokit.git.createCommit({
    owner, repo: name,
    message,
    tree: tree.sha,
    parents: [baseSha],
  });

  // Create or update branch ref
  try {
    await octokit.git.createRef({ owner, repo: name, ref: `refs/heads/${branch}`, sha: commit.sha });
  } catch (e) {
    if (e.status === 422) {
      await octokit.git.updateRef({ owner, repo: name, ref: `heads/${branch}`, sha: commit.sha, force: true });
    } else throw e;
  }

  return branch;
}
