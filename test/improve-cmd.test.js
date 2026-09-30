import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// `seo improve` orchestration: which branch the rewrite lands on and how many
// attempts it gets. Both were regressions in the first scheduled improve run
// (PR opened against a branch that was never created, one-word validation
// failure threw away a full Opus call).

const fetchPagePerformance = vi.fn();
const selectPage = vi.fn();
const improvePage = vi.fn();
const validate = vi.fn();
const createBranchAndCommit = vi.fn();
const openPR = vi.fn();
const reviewPage = vi.fn();
const complete = vi.fn();

const CONFIG = { project: 'demo', locale: 'de', locales: ['de'], landing_path: 'content/landing/de/', repo: 'o/demo' };

vi.mock('../src/steps/improve.js', () => ({
  fetchPagePerformance: (...a) => fetchPagePerformance(...a),
  selectPage: (...a) => selectPage(...a),
  improvePage: (...a) => improvePage(...a),
  keywordFor: () => ({ keyword: 'preise', expected_entities: [] }),
}));
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));
vi.mock('../src/steps/validate.js', () => ({ validate: (...a) => validate(...a) }));
vi.mock('../src/steps/review.js', () => ({
  reviewPage: (...a) => reviewPage(...a),
  unresolvedSeverity: () => null,
}));
vi.mock('../src/lib/github.js', () => ({
  createBranchAndCommit: (...a) => createBranchAndCommit(...a),
  openPR: (...a) => openPR(...a),
}));
vi.mock('../src/lib/config.js', async (orig) => ({ ...(await orig()), loadConfig: () => CONFIG }));

const { improveCommand } = await import('../src/commands/improve.js');
const { isoWeek } = await import('../src/lib/date.js');

const PAGE = {
  slug: 'preise', kind: 'snippet', reason: 'no clicks', impressions: 300, clicks: 0, bestPosition: 3,
  queries: [{ query: 'preise', position: 3, impressions: 300, clicks: 0 }],
};

let dir, cwd;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-improve-cmd-'));
  cwd = process.cwd();
  process.chdir(dir);
  for (const fn of [fetchPagePerformance, selectPage, improvePage, validate, createBranchAndCommit, openPR, reviewPage, complete]) fn.mockReset();
  reviewPage.mockImplementation(async (markdown) => ({ markdown, findings: [] }));
  fetchPagePerformance.mockResolvedValue([]);
  selectPage.mockReturnValue({ ...PAGE });
  improvePage.mockResolvedValue({ slug: 'preise', filePath: 'content/landing/de/preise.md', markdown: '---\nslug: preise\n---\nbody' });
  validate.mockReturnValue({ ok: true, errors: [], warnings: [] });
  openPR.mockResolvedValue('https://github.com/o/demo/pull/9');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('improveCommand', () => {
  it('commits to the same improve branch the PR is opened against', async () => {
    await improveCommand({ config: CONFIG });

    const branch = `seo/improve-${isoWeek()}`;
    expect(createBranchAndCommit).toHaveBeenCalledWith(expect.objectContaining({ branch }));
    expect(openPR).toHaveBeenCalledWith(expect.objectContaining({ branch }));
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
