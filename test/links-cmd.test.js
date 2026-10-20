import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const createBranchAndCommit = vi.fn();
const openPR = vi.fn();
const deleteBranch = vi.fn();
vi.mock('../src/lib/github.js', () => ({
  createBranchAndCommit: (...a) => createBranchAndCommit(...a),
  openPR: (...a) => openPR(...a),
  deleteBranch: (...a) => deleteBranch(...a),
}));

const { linksCommand } = await import('../src/commands/links.js');

const CONFIG = { project: 'demo', locale: 'de', locales: ['de'], landing_path: 'content/landing/de/', repo: 'o/demo' };
const page = (title) => `---\nmeta_title: ${title}\n---\nbody`;

let dir;
const write = (slug, markdown) => {
  mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
  writeFileSync(join(dir, 'content/landing/de', `${slug}.md`), markdown);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-links-cmd-'));
  createBranchAndCommit.mockReset().mockResolvedValue('seo/links/x');
  openPR.mockReset().mockResolvedValue('https://github.com/o/demo/pull/5');
  deleteBranch.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('linksCommand', () => {
  it('opens one PR with the edited sources and the before/after counts', async () => {
    write('hochzeit-planen', page('Hochzeit planen'));
    write('hochzeit-kosten', page('Hochzeit Kosten'));

    const url = await linksCommand({ config: CONFIG }, dir);

    expect(url).toBe('https://github.com/o/demo/pull/5');
    const { files, branch } = createBranchAndCommit.mock.calls[0][0];
    expect(branch).toMatch(/^seo\/links\/\d{4}-W\d{2}$/);
    expect(files.map(f => f.path).sort()).toEqual(['content/landing/de/hochzeit-kosten.md', 'content/landing/de/hochzeit-planen.md']);
    expect(openPR.mock.calls[0][0].body).toContain('`hochzeit-kosten` -> `hochzeit-planen` (de, inbound 0 -> 1)');
  });

  it('writes nothing on a dry run', async () => {
    write('hochzeit-planen', page('Hochzeit planen'));
    write('hochzeit-kosten', page('Hochzeit Kosten'));

    expect(await linksCommand({ config: CONFIG, dryRun: true }, dir)).toBeNull();

    expect(createBranchAndCommit).not.toHaveBeenCalled();
    expect(openPR).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'content/landing/de/hochzeit-planen.md'), 'utf8')).toBe(page('Hochzeit planen'));
  });

  it('opens no PR when nothing qualifies', async () => {
    write('hochzeit-planen', page('Hochzeit planen'));
    write('steuer-tipps', page('Steuer Tipps'));

    expect(await linksCommand({ config: CONFIG }, dir)).toBeNull();

    expect(createBranchAndCommit).not.toHaveBeenCalled();
  });

  it('skips with a warning when the branch already exists', async () => {
    write('hochzeit-planen', page('Hochzeit planen'));
    write('hochzeit-kosten', page('Hochzeit Kosten'));
    createBranchAndCommit.mockRejectedValue(Object.assign(new Error('exists'), { code: 'BRANCH_EXISTS' }));

    expect(await linksCommand({ config: CONFIG }, dir)).toBeNull();

    expect(openPR).not.toHaveBeenCalled();
  });
});
