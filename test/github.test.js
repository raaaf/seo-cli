import { describe, it, expect, vi, beforeEach } from 'vitest';

const git = {
  getRef: vi.fn(), getCommit: vi.fn(), createBlob: vi.fn(),
  deleteRef: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), createRef: vi.fn(), updateRef: vi.fn(), getTree: vi.fn(),
};
const pulls = { create: vi.fn(), get: vi.fn(), list: vi.fn(), listFiles: vi.fn() };
vi.mock('@octokit/rest', () => ({
  Octokit: class { constructor() { this.git = git; this.pulls = pulls; this.paginate = async (fn, args) => (await fn(args)).data; } },
}));

process.env.GITHUB_TOKEN = 'test-token';
const { createBranchAndCommit, commitToBranch, getBlobShas, getPR, deleteBranch, openPR, listRecentlyMergedSeoPRs } = await import('../src/lib/github.js');
const { isoWeek } = await import('../src/lib/date.js');

beforeEach(() => {
  for (const fn of [...Object.values(git), ...Object.values(pulls)]) fn.mockReset();
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

  it('uses an explicit branch name when one is given', async () => {
    const branch = await createBranchAndCommit({ files: [{ path: 'a.md', content: 'A' }], message: 'm', repo: 'o/r', branch: 'seo/improve-2026-W31' });

    expect(branch).toBe('seo/improve-2026-W31');
    expect(git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/seo/improve-2026-W31' }));
  });

  it('throws BRANCH_EXISTS instead of overwriting an existing branch (422)', async () => {
    git.createRef.mockRejectedValue(Object.assign(new Error('exists'), { status: 422 }));
    await expect(createBranchAndCommit({ files: [{ path: 'a.md', content: 'A' }], message: 'm', repo: 'o/r' }))
      .rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
    expect(git.updateRef).not.toHaveBeenCalled();
  });

  it('opens a PR and returns its html_url', async () => {
    const url = await openPR({ repo: 'o/r', branch: 'seo/x', title: 't', body: 'b' });
    expect(url).toBe('https://github.com/o/r/pull/7');
    expect(pulls.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', head: 'seo/x', base: 'main' }));
  });
});

describe('github-commit-to-branch', () => {
  const files = [{ path: 'seo/keywords.json', content: '{}' }];
  const notFastForward = () => Object.assign(new Error('not ff'), { status: 422 });

  it('advances the branch head without force', async () => {
    const sha = await commitToBranch({ files, message: 'm', repo: 'o/r', branch: 'main' });
    expect(sha).toBe('commit-sha');
    expect(git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main', sha: 'commit-sha', force: false }));
  });

  it('re-reads the head and retries after a 422', async () => {
    git.updateRef.mockRejectedValueOnce(notFastForward()).mockResolvedValue({ data: {} });
    git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'old-head' } } })
      .mockResolvedValueOnce({ data: { object: { sha: 'new-head' } } });
    await commitToBranch({ files, message: 'm', repo: 'o/r' });
    expect(git.updateRef).toHaveBeenCalledTimes(2);
    expect(git.createCommit).toHaveBeenLastCalledWith(expect.objectContaining({ parents: ['new-head'] }));
  });

  it('gives up after 3 attempts', async () => {
    git.updateRef.mockRejectedValue(notFastForward());
    await expect(commitToBranch({ files, message: 'm', repo: 'o/r' })).rejects.toThrow(/after 3 attempts/);
    expect(git.updateRef).toHaveBeenCalledTimes(3);
  });

  it('does not retry on other errors', async () => {
    git.updateRef.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(commitToBranch({ files, message: 'm', repo: 'o/r' })).rejects.toThrow('forbidden');
    expect(git.updateRef).toHaveBeenCalledTimes(1);
  });
});

describe('github-blob-shas', () => {
  it('maps blob paths to their SHA from the head tree', async () => {
    git.getTree.mockResolvedValue({ data: { tree: [
      { path: 'seo', type: 'tree', sha: 't1' },
      { path: 'seo/keywords.json', type: 'blob', sha: 'b1' },
    ] } });
    expect(await getBlobShas({ repo: 'o/r' })).toEqual({ 'seo/keywords.json': 'b1' });
  });

  it('throws when GitHub truncated the tree', async () => {
    git.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    await expect(getBlobShas({ repo: 'o/r' })).rejects.toThrow(/truncated/);
  });
});

describe('github-get-pr', () => {
  const pr = (data) => pulls.get.mockResolvedValue({ data });

  it('reports a merged PR with its merge date, read by url', async () => {
    pr({ state: 'closed', merged: true, merged_at: '2026-10-01T10:00:00Z' });
    expect(await getPR({ repo: 'o/r', url: 'https://github.com/o/r/pull/12' })).toMatchObject({ state: 'merged', mergedAt: '2026-10-01T10:00:00Z' });
    expect(pulls.get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', pull_number: 12 });
  });

  it('tells a closed-unmerged PR from an open one', async () => {
    pr({ state: 'closed', merged: false, merged_at: null });
    expect((await getPR({ repo: 'o/r', number: 3 })).state).toBe('closed');
    pr({ state: 'open', merged: false, merged_at: null });
    expect((await getPR({ repo: 'o/r', number: 3 })).state).toBe('open');
  });

  it('returns the creation timestamp, null when absent', async () => {
    pr({ state: 'open', merged: false, created_at: '2026-10-06T08:00:00Z' });
    expect((await getPR({ repo: 'o/r', number: 3 })).createdAt).toBe('2026-10-06T08:00:00Z');
    pr({ state: 'open', merged: false });
    expect((await getPR({ repo: 'o/r', number: 3 })).createdAt).toBeNull();
  });

  it('returns the head branch name', async () => {
    pr({ state: 'closed', merged: false, head: { ref: 'seo/new/x' } });
    expect((await getPR({ repo: 'o/r', number: 3 })).headRef).toBe('seo/new/x');
  });

  it('rejects a reference without a PR number', async () => {
    await expect(getPR({ repo: 'o/r', url: 'https://github.com/o/r' })).rejects.toThrow(/Not a pull request/);
  });
});

describe('github-delete-branch', () => {
  it('deletes the branch ref', async () => {
    git.deleteRef.mockResolvedValue({});
    await deleteBranch({ repo: 'o/r', branch: 'seo/new/x' });
    expect(git.deleteRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r', ref: 'heads/seo/new/x' });
  });

  it('tolerates a branch that is already gone (404) but not other errors', async () => {
    git.deleteRef.mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404 }));
    await expect(deleteBranch({ repo: 'o/r', branch: 'b' })).resolves.toBeUndefined();
    git.deleteRef.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(deleteBranch({ repo: 'o/r', branch: 'b' })).rejects.toThrow('forbidden');
  });
});

describe('github-list-merged-seo-prs', () => {
  const pr = (number, ref, mergedAt) => ({ number, head: { ref }, merged_at: mergedAt });

  it('keeps merged PRs of seo/new and seo/improve since the cutoff, with their changed files', async () => {
    pulls.list.mockResolvedValue({ data: [
      pr(1, 'seo/new/a', '2026-10-05T10:00:00Z'),
      pr(2, 'seo/improve/product-b', '2026-10-04T10:00:00Z'),
      pr(3, 'seo/new/old', '2026-09-01T10:00:00Z'),
      pr(4, 'feature/x', '2026-10-05T10:00:00Z'),
      pr(5, 'seo/new/closed', null),
      pr(6, 'seo/2026-W40', '2026-10-05T10:00:00Z'),
    ] });
    pulls.listFiles.mockImplementation(async ({ pull_number }) => ({ data: [{ filename: `f${pull_number}.md` }] }));

    const result = await listRecentlyMergedSeoPRs('o/r', '2026-09-25T00:00:00.000Z');

    expect(result).toEqual([
      { number: 1, headRef: 'seo/new/a', mergedAt: '2026-10-05T10:00:00Z', files: ['f1.md'] },
      { number: 2, headRef: 'seo/improve/product-b', mergedAt: '2026-10-04T10:00:00Z', files: ['f2.md'] },
    ]);
    expect(pulls.list).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', state: 'closed' }));
  });
});
