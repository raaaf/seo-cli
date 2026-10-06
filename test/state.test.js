import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const git = {
  getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), createBlob: vi.fn(),
  createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn(),
};
vi.mock('@octokit/rest', () => ({
  Octokit: class { constructor() { this.git = git; } },
}));

process.env.GITHUB_TOKEN = 'test-token';
const { commitState, gitBlobSha } = await import('../src/lib/state.js');

let dir;
function write(path, content) {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, path), content);
}
function remoteTree(entries) {
  git.getTree.mockResolvedValue({ data: { tree: Object.entries(entries).map(([path, sha]) => ({ path, type: 'blob', sha })) } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-state-'));
  for (const fn of Object.values(git)) fn.mockReset();
  git.getRef.mockResolvedValue({ data: { object: { sha: 'head' } } });
  git.getCommit.mockResolvedValue({ data: { tree: { sha: 'tree' } } });
  git.createBlob.mockResolvedValue({ data: { sha: 'blob' } });
  git.createTree.mockResolvedValue({ data: { sha: 'new-tree' } });
  git.createCommit.mockResolvedValue({ data: { sha: 'commit' } });
  git.updateRef.mockResolvedValue({ data: {} });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('state: gitBlobSha', () => {
  it('matches git hash-object for known content', () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('hashes the UTF-8 byte length, not the character count', () => {
    // "blob 3\0" + "ä\n" (ä is 2 bytes)
    expect(gitBlobSha('ä\n')).toBe(createHash('sha1').update(Buffer.concat([Buffer.from('blob 3\0'), Buffer.from('ä\n')])).digest('hex'));
  });
});

describe('state: commitState', () => {
  it('makes no commit when every state file matches main', async () => {
    write('seo/keywords.json', '{}\n');
    remoteTree({ 'seo/keywords.json': gitBlobSha('{}\n') });
    expect(await commitState({ cwd: dir, repo: 'o/r', reason: 'x' })).toEqual([]);
    expect(git.createCommit).not.toHaveBeenCalled();
    expect(git.updateRef).not.toHaveBeenCalled();
  });

  it('commits only the files that differ, with a [skip ci] message', async () => {
    write('seo/keywords.json', '{"a":1}\n');
    write('seo/budget.json', '{}\n');
    remoteTree({ 'seo/keywords.json': gitBlobSha('{}\n'), 'seo/budget.json': gitBlobSha('{}\n') });

    const committed = await commitState({ cwd: dir, repo: 'o/r', reason: 'run' });

    expect(committed).toEqual(['seo/keywords.json']);
    expect(git.createBlob).toHaveBeenCalledTimes(1);
    expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'seo: state (run) [skip ci]' }));
    expect(git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main', force: false }));
  });

  it('commits a state file that does not exist on main yet', async () => {
    write('seo/budget.json', '{}\n');
    remoteTree({});
    expect(await commitState({ cwd: dir, repo: 'o/r', reason: 'run' })).toEqual(['seo/budget.json']);
  });
});
