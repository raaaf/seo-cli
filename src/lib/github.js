import { Octokit } from '@octokit/rest';
import { isoWeek } from './date.js';

let octokit;
function getOctokit() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  if (!octokit) octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  return octokit;
}

export async function openPR({ repo, branch, title, body, baseBranch = 'main' }) {
  const octokit = getOctokit();
  const [owner, name] = repo.split('/');

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

export async function createBranchAndCommit({ files, message, cwd: _cwd, repo, baseBranch = 'main' }) {
  const octokit = getOctokit();
  const [owner, name] = repo.split('/');
  const branch = `seo/${isoWeek()}`;

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
