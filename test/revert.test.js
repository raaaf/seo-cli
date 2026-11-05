import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { revertWorseRewrites, revertCandidates, filesToRestore } = await import('../src/steps/revert.js');

const PR = 'https://github.com/o/r/pull/7';
const config = { repo: 'o/r', base_url: 'https://a.de', locale: 'de', landing_path: 'content/landing/de/' };
const entry = (extra = {}) => ({
  id: PR, kind: 'rewrite', slug: 'team', urls: ['https://a.de/team', 'https://a.de/team-en'], pr_url: PR, merged_at: '2026-08-01',
  readings: { d28: { verdict: 'negative', effect: 0.6, metric: 'clicks' }, d56: { verdict: 'negative', effect: 0.5, metric: 'clicks' } },
  revert_candidate: true, ...extra,
});
const FILES = [
  { path: 'content/landing/de/team.md', status: 'modified' },
  { path: 'content/landing/en/team-en.md', status: 'modified' },
  { path: 'content/landing/de/other.md', status: 'modified' }, // inbound link edit, stays
];

// A fake GitHub: `now` overrides the current content of a path on the default branch.
function fakeGh({ files = FILES, now = {}, merged = true } = {}) {
  const calls = { commits: [], prs: [] };
  const at = { merge: 'm', parent: 'p', main: 'main' };
  return {
    calls,
    getMergedPRChanges: async () => merged ? { mergeSha: at.merge, parentSha: at.parent, files } : null,
    getDefaultBranch: async () => at.main,
    getFileAt: async ({ path, ref }) => {
      if (ref === at.parent) return { sha: `old-${path}`, content: `old ${path}` };
      if (ref === at.merge) return { sha: `new-${path}`, content: `new ${path}` };
      return now[path] ?? { sha: `new-${path}`, content: `new ${path}` };
    },
    createBranchAndCommit: async (args) => { calls.commits.push(args); return args.branch; },
    openPR: async (args) => { calls.prs.push(args); return 'https://github.com/o/r/pull/9'; },
    deleteBranch: async () => {},
  };
}

describe('revert of rewrites that measured worse', () => {
  let dir;
  const write = (changes, improvements = { entries: [] }) => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/changes.json'), JSON.stringify({ version: 1, entries: changes, skipped: [] }));
    writeFileSync(join(dir, 'seo/improvements.json'), JSON.stringify({ version: 1, ...improvements }));
  };
  const read = (f) => JSON.parse(readFileSync(join(dir, 'seo', f), 'utf8'));
  const run = (gh, extra = {}) => revertWorseRewrites({ config, cwd: dir, today: '2026-11-05', gh, check: () => [], ...extra });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-revert-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores the page and its counterpart, not other pages, and records the outcome', async () => {
    write([entry()]);
    const gh = fakeGh();
    const warnings = [];
    const out = await run(gh, { warnings });
    expect(warnings).toEqual([]);
    expect(out).toEqual([{ slug: 'team', status: 'opened', pr_url: 'https://github.com/o/r/pull/9' }]);
    expect(gh.calls.commits[0].branch).toBe('seo/revert/team');
    expect(gh.calls.commits[0].files).toEqual([
      { path: 'content/landing/de/team.md', content: 'old content/landing/de/team.md' },
      { path: 'content/landing/en/team-en.md', content: 'old content/landing/en/team-en.md' },
    ]);
    expect(gh.calls.prs[0].body).toContain(PR);
    expect(read('changes.json').entries[0].revert).toEqual({ status: 'opened', pr_url: 'https://github.com/o/r/pull/9', date: '2026-11-05' });
    expect(read('improvements.json').entries).toEqual([{ slug: 'team', date: '2026-11-05', queries: [], pr_url: 'https://github.com/o/r/pull/9', revert: true }]);
  });

  it('decides each entry once', async () => {
    write([entry({ revert: { status: 'opened', date: '2026-10-01' } }), entry({ id: 'x', revert_candidate: false })]);
    const gh = fakeGh();
    expect(await run(gh)).toEqual([]);
    expect(gh.calls.commits).toEqual([]);
  });

  it('leaves a page alone that changed since the rewrite', async () => {
    write([entry()]);
    const gh = fakeGh({ now: { 'content/landing/en/team-en.md': { sha: 'edited', content: 'edited' } } });
    expect(await run(gh)).toEqual([{ slug: 'team', status: 'skipped', reason: 'changed_since' }]);
    expect(gh.calls.commits).toEqual([]);
    expect(read('changes.json').entries[0].revert).toMatchObject({ status: 'skipped', reason: 'changed_since' });
  });

  it('never reverts a PR that deleted pages', async () => {
    write([entry()]);
    const gh = fakeGh({ files: [...FILES, { path: 'content/landing/de/old.md', status: 'removed' }] });
    expect(await run(gh)).toEqual([{ slug: 'team', status: 'skipped', reason: 'deletes_or_moves_pages' }]);
    expect(gh.calls.commits).toEqual([]);
  });

  it('skips when the old version would fail seo check', async () => {
    write([entry()]);
    const gh = fakeGh();
    const warnings = [];
    expect(await run(gh, { warnings, check: () => ['Body too short'] })).toEqual([{ slug: 'team', status: 'skipped', reason: 'previous_version_fails_check' }]);
    expect(warnings[0]).toMatch(/Body too short/);
    expect(gh.calls.commits).toEqual([]);
  });

  it('waits for an open rewrite PR and marks a page rewritten again as superseded', async () => {
    write([entry()], { entries: [{ slug: 'team', date: '2026-10-20', pr_url: 'https://github.com/o/r/pull/8' }] });
    expect(await run(fakeGh())).toEqual([]);
    write([entry()], { entries: [{ slug: 'team', date: '2026-10-20', pr_url: 'https://github.com/o/r/pull/8', merged_at: '2026-10-21' }] });
    expect(await run(fakeGh())).toEqual([{ slug: 'team', status: 'superseded' }]);
    expect(read('changes.json').entries[0].revert).toMatchObject({ status: 'superseded' });
  });

  it('keeps GitHub errors and existing branches as warnings, retried next run', async () => {
    write([entry()]);
    const gh = fakeGh();
    gh.createBranchAndCommit = async () => { throw Object.assign(new Error('exists'), { code: 'BRANCH_EXISTS' }); };
    const warnings = [];
    expect(await run(gh, { warnings })).toEqual([]);
    expect(warnings[0]).toMatch(/already exists/);
    expect(read('changes.json').entries[0].revert).toBeUndefined();
  });

  it('is off with auto_revert: false', async () => {
    write([entry()]);
    const gh = fakeGh();
    expect(await revertWorseRewrites({ config: { ...config, auto_revert: false }, cwd: dir, gh })).toEqual([]);
  });

  it('pure helpers', () => {
    expect(filesToRestore(entry(), [{ path: 'content/landing/de/other.md', status: 'modified' }])).toEqual({ skip: 'no_page_files' });
    expect(revertCandidates({ changes: { entries: [entry({ kind: 'revert' })] }, improvements: { entries: [] } })).toEqual([]);
  });
});
