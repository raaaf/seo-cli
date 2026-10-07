import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// `seo improve` orchestration: which branch the rewrite lands on and how many
// attempts it gets, and when the cooldown entry is written. The first two were regressions in the first scheduled improve run
// (PR opened against a branch that was never created, one-word validation
// failure threw away a full Opus call).

const fetchPagePerformance = vi.fn();
const selectPage = vi.fn();
const improvePage = vi.fn();
const targetedPage = vi.fn();
const validate = vi.fn();
const createBranchAndCommit = vi.fn();
const openPR = vi.fn();
const deleteBranch = vi.fn();
const reviewPage = vi.fn();
const complete = vi.fn();
const commitState = vi.fn();

const CONFIG = { project: 'demo', locale: 'de', locales: ['de'], landing_path: 'content/landing/de/', repo: 'o/demo' };

vi.mock('../src/steps/improve.js', () => ({
  fetchPagePerformance: (...a) => fetchPagePerformance(...a),
  selectPage: (...a) => selectPage(...a),
  improvePage: (...a) => improvePage(...a),
  targetedPage: (...a) => targetedPage(...a),
  keywordFor: () => ({ keyword: 'preise', expected_entities: [] }),
}));
vi.mock('../src/lib/claude.js', () => ({
  complete: (...a) => complete(...a),
  getLlmStats: () => ({ subscription_calls: 0, api_calls: 0, usd_equivalent: 0, fallbacks: [] }),
}));
vi.mock('../src/steps/validate.js', () => ({ validate: (...a) => validate(...a) }));
vi.mock('../src/steps/review.js', () => ({
  reviewPage: (...a) => reviewPage(...a),
  unresolvedSeverity: () => null,
}));
vi.mock('../src/lib/github.js', () => ({
  createBranchAndCommit: (...a) => createBranchAndCommit(...a),
  openPR: (...a) => openPR(...a),
  deleteBranch: (...a) => deleteBranch(...a),
}));
vi.mock('../src/lib/state.js', () => ({ commitState: (...a) => commitState(...a) }));
vi.mock('../src/lib/config.js', async (orig) => ({ ...(await orig()), loadConfig: () => CONFIG }));

const { BudgetExceededError } = await import('../src/lib/budget.js');
const { improveCommand, prepareImprove, publishImprove } = await import('../src/commands/improve.js');
const { loadImprovements } = await import('../src/lib/improvements.js');

const PAGE = {
  slug: 'preise', kind: 'snippet', reason: 'no clicks', impressions: 300, clicks: 0, bestPosition: 3,
  queries: [{ query: 'preise', position: 3, impressions: 300, clicks: 0 }],
};

let dir, cwd;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-improve-cmd-'));
  cwd = process.cwd();
  process.chdir(dir);
  for (const fn of [fetchPagePerformance, selectPage, improvePage, targetedPage, validate, createBranchAndCommit, openPR, deleteBranch, reviewPage, complete, commitState]) fn.mockReset();
  reviewPage.mockImplementation(async (markdown) => ({ markdown, findings: [] }));
  fetchPagePerformance.mockResolvedValue([]);
  selectPage.mockReturnValue({ ...PAGE });
  improvePage.mockResolvedValue({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: '---\nslug: preise\n---\nbody' });
  validate.mockReturnValue({ ok: true, errors: [], warnings: [] });
  openPR.mockResolvedValue('https://github.com/o/demo/pull/9');
  deleteBranch.mockResolvedValue();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('improveCommand', () => {
  it('writes the run log before the last state commit, and none on a dry run', async () => {
    const seen = [];
    commitState.mockImplementation(async () => { seen.push(existsSync(join(dir, 'seo/last-run.json'))); return []; });

    await improveCommand({ config: CONFIG });
    expect(seen).toEqual([false, true]);
    expect(JSON.parse(readFileSync(join(dir, 'seo/last-run.json'), 'utf8'))).toMatchObject({ mode: 'improve', status: 'prs_opened' });

    rmSync(join(dir, 'seo'), { recursive: true });
    await improveCommand({ config: CONFIG, dryRun: true });
    expect(existsSync(join(dir, 'seo/last-run.json'))).toBe(false);
  });

  it('writes the run log and commits state when the preparation throws, and keeps that error', async () => {
    selectPage.mockImplementation(() => { throw new BudgetExceededError('Anthropic monthly budget exhausted'); });
    commitState.mockResolvedValue([]);

    await expect(improveCommand({ config: CONFIG })).rejects.toThrow(BudgetExceededError);

    expect(JSON.parse(readFileSync(join(dir, 'seo/last-run.json'), 'utf8'))).toMatchObject({ status: 'failed' });
    expect(commitState).toHaveBeenCalledTimes(1);
    expect(commitState).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/results$/) }));
  });

  it('keeps the original error when the last state commit fails as well', async () => {
    openPR.mockRejectedValue(new Error('GitHub 500'));
    commitState.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('push rejected'));

    await expect(improveCommand({ config: CONFIG })).rejects.toThrow('GitHub 500');
  });

  it('commits to the same per-page improve branch the PR is opened against', async () => {
    await improveCommand({ config: CONFIG });

    const branch = 'seo/improve/preise';
    expect(createBranchAndCommit).toHaveBeenCalledWith(expect.objectContaining({ branch }));
    expect(openPR).toHaveBeenCalledWith(expect.objectContaining({ branch }));
  });

  it('puts no state file into the PR and syncs state to main before and after it', async () => {
    const order = [];
    commitState.mockImplementation(async () => { order.push('state'); return []; });
    createBranchAndCommit.mockImplementation(async () => { order.push('pr'); });

    await improveCommand({ config: CONFIG });

    expect(order).toEqual(['state', 'pr', 'state']);
    expect(createBranchAndCommit.mock.calls[0][0].files.map(f => f.path)).toEqual(['content/landing/de/preise.md']);
  });

  describe('improve-cooldown', () => {
    it('is not recorded by prepareImprove', async () => {
      const prepared = await prepareImprove({ config: CONFIG });

      expect(prepared.slug).toBe('preise');
      expect(loadImprovements(dir).entries).toEqual([]);
    });

    it('is recorded with the PR url after the PR was opened', async () => {
      await improveCommand({ config: CONFIG });

      expect(loadImprovements(dir).entries).toEqual([
        expect.objectContaining({ slug: 'preise', pr_url: 'https://github.com/o/demo/pull/9' }),
      ]);
    });

    it('is not recorded when the branch exists, which is reported as a warning', async () => {
      createBranchAndCommit.mockRejectedValue(Object.assign(new Error('exists'), { code: 'BRANCH_EXISTS' }));
      const warnings = [];

      const url = await publishImprove(await prepareImprove({ config: CONFIG }), { config: CONFIG, warnings });

      expect(url).toBeNull();
      expect(openPR).not.toHaveBeenCalled();
      expect(loadImprovements(dir).entries).toEqual([]);
      expect(warnings[0]).toMatch(/seo\/improve\/preise already exists/);
    });

    it('is not recorded when opening the PR fails', async () => {
      openPR.mockRejectedValue(new Error('GitHub 500'));

      await expect(improveCommand({ config: CONFIG })).rejects.toThrow('GitHub 500');
      expect(loadImprovements(dir).entries).toEqual([]);
      expect(deleteBranch).toHaveBeenCalledWith({ repo: 'o/demo', branch: 'seo/improve/preise' });
    });
  });

  it('retries once with the validator errors and keeps the second rewrite', async () => {
    validate
      .mockReturnValueOnce({ ok: false, errors: ['tldr too long: 61 words (max 60)'], warnings: [] })
      .mockReturnValue({ ok: true, errors: [], warnings: [] });
    improvePage
      .mockResolvedValueOnce({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: 'first' })
      .mockResolvedValue({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: 'second' });

    await improveCommand({ config: CONFIG });

    expect(improvePage).toHaveBeenCalledTimes(2);
    expect(improvePage.mock.calls[1][3]).toEqual(expect.objectContaining({ errors: ['tldr too long: 61 words (max 60)'] }));
    expect(createBranchAndCommit.mock.calls[0][0].files[0].content).toBe('second');
  });

  it('discards the rewrite when both attempts fail validation', async () => {
    validate.mockReturnValue({ ok: false, errors: ['tldr too long'], warnings: [] });

    const url = await improveCommand({ config: CONFIG });

    expect(url).toBeNull();
    expect(improvePage).toHaveBeenCalledTimes(2);
    expect(createBranchAndCommit).not.toHaveBeenCalled();
    expect(openPR).not.toHaveBeenCalled();
  });

  it('forces an interactive rewrite on a dry run', async () => {
    const config = { ...CONFIG, batch_generation: true };

    await improveCommand({ config, dryRun: true });

    expect(improvePage.mock.calls[0][1].batch_generation).toBe(false);
  });

  it('puts a fact-check warning at the top of the PR body when the check did not run', async () => {
    reviewPage.mockImplementation(async (markdown) => ({ markdown, findings: [], unchecked: true, error: 'Claude returned no JSON' }));

    await improveCommand({ config: CONFIG });

    const body = openPR.mock.calls[0][0].body;
    expect(body.startsWith('**ACHTUNG')).toBe(true);
    expect(body).toContain('Claude returned no JSON');
  });

  it('adds no fact-check warning when the check ran', async () => {
    await improveCommand({ config: CONFIG });

    expect(openPR.mock.calls[0][0].body).not.toContain('ACHTUNG');
  });

  it('lists the validator warnings that remain on the rewrite in the PR body', async () => {
    validate.mockReturnValue({ ok: true, errors: [], warnings: ['hero.headline may not contain target keyword (missing: preise)'] });

    await improveCommand({ config: CONFIG });

    expect(openPR.mock.calls[0][0].body).toContain('hero.headline may not contain target keyword');
  });

  it('lists no validator warnings in the PR body when the rewrite is clean', async () => {
    await improveCommand({ config: CONFIG });

    expect(openPR.mock.calls[0][0].body).not.toContain('Validator-Warnungen');
  });

  describe('counterpart re-adaptation', () => {
    const CP_CONFIG = { ...CONFIG, counterpart_locale: 'en', site_name: 'Demo' };
    const page = (slug, faq, alternate) => [
      '---', `slug: ${slug}`, ...(alternate ? [`alternate: ${alternate}`] : []),
      'faq:', ...Array.from({ length: faq }, (_, n) => `  - q: "Q${n}"\n    a: "A${n}"`),
      '---', 'body',
    ].join('\n');
    const filesOfCommit = () => createBranchAndCommit.mock.calls[0][0].files.map(f => f.path);

    beforeEach(() => {
      mkdirSync(join(dir, 'content/landing/en'), { recursive: true });
      writeFileSync(join(dir, 'content/landing/en/pricing.md'), page('pricing', 1, 'preise'));
      improvePage.mockResolvedValue({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: page('preise', 2, 'pricing') });
    });

    it('re-adapts the counterpart with its existing slug and ships it in the same PR', async () => {
      complete.mockResolvedValue(page('some-new-slug', 2));

      await improveCommand({ config: CP_CONFIG });

      const counterpart = createBranchAndCommit.mock.calls[0][0].files.find(f => f.path === 'content/landing/en/pricing.md');
      expect(counterpart.content).toContain('slug: pricing\nalternate: preise');
      expect(complete.mock.calls[0][0].batch).toBeUndefined();
      expect(openPR.mock.calls[0][0].body).toContain('`pricing`');
    });

    it('skips the counterpart when the rewrite has no alternate', async () => {
      improvePage.mockResolvedValue({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: page('preise', 2) });

      await improveCommand({ config: CP_CONFIG });

      expect(complete).not.toHaveBeenCalled();
      expect(filesOfCommit()).not.toContain('content/landing/en/pricing.md');
      expect(openPR.mock.calls[0][0].body).not.toContain('Counterpart');
    });

    it('retries with feedback when the counterpart FAQ count differs from the German page', async () => {
      complete.mockResolvedValueOnce(page('pricing', 1)).mockResolvedValueOnce(page('pricing', 2));

      await improveCommand({ config: CP_CONFIG });

      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[1][0].prompt).toContain('faq count differs from the source page: 1 instead of 2');
      expect(filesOfCommit()).toContain('content/landing/en/pricing.md');
    });

    it('keeps the German rewrite and flags the PR when the counterpart fails twice', async () => {
      complete.mockResolvedValue(page('pricing', 1));

      await improveCommand({ config: CP_CONFIG });

      expect(complete).toHaveBeenCalledTimes(2);
      expect(filesOfCommit()).toContain('content/landing/de/preise.md');
      expect(filesOfCommit()).not.toContain('content/landing/en/pricing.md');
      expect(openPR.mock.calls[0][0].body).toContain('Counterpart pricing could not be re-adapted');
    });
  });
});

describe('improve --slug', () => {
  const TARGET = { slug: 'preise', mergeFrom: ['alt-a', 'alt-b'], kind: 'targeted', reason: 'targeted rewrite, merging alt-a, alt-b', diagnosis: 'd', impressions: 0, clicks: 0, bestPosition: 0, queries: [] };
  const landing = (name, content) => {
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    writeFileSync(join(dir, 'content/landing/de', `${name}.md`), content);
  };

  beforeEach(() => {
    targetedPage.mockReturnValue({ ...TARGET });
    landing('preise', '---\nslug: preise\n---\nbody');
    landing('alt-a', '---\nslug: alt-a\n---\nA');
    landing('alt-b', '---\nslug: alt-b\n---\nB');
    landing('other', '---\nslug: other\nrelated_pages:\n  - alt-a\n  - kept\n  - alt-b\n---\nO');
    landing('untouched', '---\nslug: untouched\nrelated_pages:\n  - kept\n---\nU');
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/redirects.json'), JSON.stringify({ old: 'alt-a' }));
  });

  it('skips Search Console and selection', async () => {
    await prepareImprove({ config: CONFIG, slug: 'preise', mergeFrom: ['alt-a', 'alt-b'], brief: undefined });

    expect(fetchPagePerformance).not.toHaveBeenCalled();
    expect(selectPage).not.toHaveBeenCalled();
    expect(targetedPage).toHaveBeenCalledWith({ slug: 'preise', mergeFrom: ['alt-a', 'alt-b'], brief: null }, CONFIG, expect.any(String));
  });

  it('passes the brief file content on', async () => {
    writeFileSync(join(dir, 'brief.md'), 'fix the legal errors');
    await prepareImprove({ config: CONFIG, slug: 'preise', brief: 'brief.md' });

    expect(targetedPage.mock.calls[0][0].brief).toBe('fix the legal errors');
  });

  it('refuses --merge-from and --brief without --slug', async () => {
    await expect(prepareImprove({ config: CONFIG, mergeFrom: ['alt-a'] })).rejects.toThrow(/need --slug/);
  });

  it('puts rewrite, deletions, redirects and repointed related pages into one PR', async () => {
    const prepared = await prepareImprove({ config: CONFIG, slug: 'preise', mergeFrom: ['alt-a', 'alt-b'] });
    const byPath = Object.fromEntries(prepared.files.map(f => [f.path, f]));

    expect(Object.keys(byPath).sort()).toEqual([
      'content/landing/de/alt-a.md', 'content/landing/de/alt-b.md', 'content/landing/de/other.md',
      'content/landing/de/preise.md', 'seo/redirects.json',
    ]);
    expect(byPath['content/landing/de/alt-a.md'].delete).toBe(true);
    expect(byPath['content/landing/de/alt-b.md'].delete).toBe(true);
    expect(JSON.parse(byPath['seo/redirects.json'].content)).toEqual({ old: 'preise', 'alt-a': 'preise', 'alt-b': 'preise' });
    expect(byPath['content/landing/de/other.md'].content).toBe('---\nslug: other\nrelated_pages:\n  - preise\n  - kept\n---\nO');
    expect(prepared.files.some(f => f.path.includes('keywords.json'))).toBe(false);
  });

  it('opens a plain rewrite PR without merge files when nothing is merged', async () => {
    targetedPage.mockReturnValue({ ...TARGET, mergeFrom: [] });
    const prepared = await prepareImprove({ config: CONFIG, slug: 'preise' });

    expect(prepared.files.map(f => f.path)).toEqual(['content/landing/de/preise.md']);
  });
});
