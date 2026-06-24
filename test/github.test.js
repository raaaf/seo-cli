import { describe, it, expect, vi, beforeEach } from 'vitest';

const git = {
  getRef: vi.fn(), getCommit: vi.fn(), createBlob: vi.fn(),
  createTree: vi.fn(), createCommit: vi.fn(), createRef: vi.fn(), updateRef: vi.fn(),
};
const pulls = { create: vi.fn() };
vi.mock('@octokit/rest', () => ({
  Octokit: class { constructor() { this.git = git; this.pulls = pulls; } },
}));

process.env.GITHUB_TOKEN = 'test-token';
const { createBranchAndCommit, openPR } = await import('../src/lib/github.js');
const { isoWeek } = await import('../src/lib/date.js');

beforeEach(() => {
  for (const fn of [...Object.values(git), pulls.create]) fn.mockReset();
  git.getRef.mockResolvedValue({ data: { object: { sha: 'base-sha' } } });
  git.getCommit.mockResolvedValue({ data: { tree: { sha: 'base-tree' } } });
  git.createBlob.mockResolvedValue({ data: { sha: 'blob-sha' } });
  git.createTree.mockResolvedValue({ data: { sha: 'new-tree' } });
  git.createCommit.mockResolvedValue({ data: { sha: 'commit-sha' } });
  git.createRef.mockResolvedValue({ data: {} });
  pulls.create.mockResolvedValue({ data: { html_url: 'https://github.com/o/r/pull/7' } });
});

describe('github-commit', () => {
  it('builds blobs/tree/commit and creates the weekly branch ref', async () => {
    const files = [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }];
    const branch = await createBranchAndCommit({ files, message: 'msg', repo: 'o/r' });

    expect(branch).toBe(`seo/${isoWeek()}`);
    expect(git.createBlob).toHaveBeenCalledTimes(2);
    expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'msg', tree: 'new-tree', parents: ['base-sha'] }));
    expect(git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: `refs/heads/seo/${isoWeek()}`, sha: 'commit-sha' }));
    expect(git.updateRef).not.toHaveBeenCalled();
  });

  it('falls back to updateRef when the branch already exists (422)', async () => {
    git.createRef.mockRejectedValue(Object.assign(new Error('exists'), { status: 422 }));
    await createBranchAndCommit({ files: [{ path: 'a.md', content: 'A' }], message: 'm', repo: 'o/r' });
    expect(git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: true, sha: 'commit-sha' }));
  });

  it('opens a PR and returns its html_url', async () => {
    const url = await openPR({ repo: 'o/r', branch: 'seo/x', title: 't', body: 'b' });
    expect(url).toBe('https://github.com/o/r/pull/7');
    expect(pulls.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', head: 'seo/x', base: 'main' }));
  });
});
