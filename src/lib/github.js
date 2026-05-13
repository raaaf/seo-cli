import { Octokit } from '@octokit/rest';
import { simpleGit } from 'simple-git';
import { isoWeek } from './date.js';

function getOctokit() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
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

export async function createBranchAndCommit({ files, message, cwd }) {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { dirname, join } = await import('path');

  const git = simpleGit(cwd);
  const branch = `seo/${isoWeek()}`;

  // Embed token in remote URL so HTTPS push works with any org/repo
  const token = process.env.GITHUB_TOKEN;
  const remoteUrl = await git.remote(['get-url', 'origin']);
  const authedUrl = remoteUrl.trim().replace('https://', `https://${token}@`);
  await git.remote(['set-url', 'origin', authedUrl]);

  const branches = await git.branchLocal();
  if (branches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    await git.checkoutLocalBranch(branch);
  }

  for (const { path, content } of files) {
    const fullPath = join(cwd, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
    await git.add(path);
  }

  await git.commit(message);
  await git.push('origin', branch, ['--set-upstream']);

  // Restore clean remote URL (no token in git config)
  await git.remote(['set-url', 'origin', remoteUrl.trim()]);

  return branch;
}
