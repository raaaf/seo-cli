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
const prepareOverlay = vi.fn();
vi.mock('../src/steps/overlay.js', () => ({ prepareOverlay: (...a) => prepareOverlay(...a) }));
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
  for (const fn of [prepareOverlay, fetchPagePerformance, selectPage, improvePage, targetedPage, validate, createBranchAndCommit, openPR, deleteBranch, reviewPage, complete, commitState]) fn.mockReset();
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

  describe('inbound links', () => {
    const landing = (slug, related = []) => {
      mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
      const list = related.length ? `related_pages:\n${related.map(s => `  - ${s}`).join('\n')}\n` : '';
      writeFileSync(join(dir, 'content/landing/de', `${slug}.md`), `---\nmeta_title: ${slug}\n${list}---\nbody`);
    };

    it('adds on-topic pages that link to a rewritten page with fewer than 3 inbound links', async () => {
      landing('preise-vergleich');
      await improveCommand({ config: CONFIG });

      const { files } = createBranchAndCommit.mock.calls[0][0];
      expect(files.map(f => f.path)).toEqual(['content/landing/de/preise.md', 'content/landing/de/preise-vergleich.md']);
      expect(files[1].content).toContain('related_pages:\n  - preise');
      expect(openPR.mock.calls[0][0].body).toContain('`preise-vergleich` -> `preise`');
    });

    it('adds nothing once the page has 3 inbound links', async () => {
      landing('preise');
      for (const slug of ['preise-a', 'preise-b', 'preise-c']) landing(slug, ['preise']);
      landing('preise-d');
      await improveCommand({ config: CONFIG });

      expect(createBranchAndCommit.mock.calls[0][0].files.map(f => f.path)).toEqual(['content/landing/de/preise.md']);
    });
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

  describe('overlay fallback', () => {
    const OVERLAY_CONFIG = { ...CONFIG, overlays: { products: 'content/seo/products' } };
    const OVERLAY_PREPARED = {
      slug: 'product:nachteule', branch: 'seo/improve/product-nachteule', files: [{ path: 'content/seo/products/nachteule.md', content: 'x' }],
      record: { slug: 'product:nachteule', queries: [] }, commitMessage: 'm', prTitle: 't', prBody: 'b',
    };

    it('hands the slot to an overlay when no landing page qualifies and overlays are configured', async () => {
      selectPage.mockReturnValue(null);
      prepareOverlay.mockResolvedValue(OVERLAY_PREPARED);

      const prepared = await prepareImprove({ config: OVERLAY_CONFIG });

      expect(prepared).toBe(OVERLAY_PREPARED);
      expect(prepareOverlay).toHaveBeenCalledWith(expect.objectContaining({ config: OVERLAY_CONFIG, dryRun: false }));
    });

    it('leaves the slot empty without the overlays key, and when the caller skips overlays', async () => {
      selectPage.mockReturnValue(null);
      expect(await prepareImprove({ config: CONFIG })).toBeNull();
      expect(await prepareImprove({ config: OVERLAY_CONFIG, skipOverlays: true })).toBeNull();
      expect(prepareOverlay).not.toHaveBeenCalled();
    });

    it('prefers the landing page rewrite over an overlay', async () => {
      await prepareImprove({ config: OVERLAY_CONFIG });
      expect(prepareOverlay).not.toHaveBeenCalled();
    });

    it('opens the overlay PR on its own branch and records the namespaced key', async () => {
      await publishImprove(OVERLAY_PREPARED, { config: CONFIG });

      expect(createBranchAndCommit).toHaveBeenCalledWith(expect.objectContaining({ branch: 'seo/improve/product-nachteule' }));
      expect(openPR).toHaveBeenCalledWith(expect.objectContaining({ branch: 'seo/improve/product-nachteule' }));
      expect(loadImprovements(dir).entries[0]).toMatchObject({ slug: 'product:nachteule', pr_url: 'https://github.com/o/demo/pull/9' });
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

  it('does not claim a fact check when fact_check is off', async () => {
    await improveCommand({ config: { ...CONFIG, fact_check: false } });

    const body = openPR.mock.calls[0][0].body;
    expect(body).toContain('aber nicht faktengeprüft');
    expect(reviewPage).not.toHaveBeenCalled();
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

describe('buildMergeFiles with a counterpart locale', () => {
  const EN_CONFIG = { ...CONFIG, locales: ['de', 'en'], counterpart_locale: 'en' };
  const page = (loc, name, content) => {
    mkdirSync(join(dir, `content/landing/${loc}`), { recursive: true });
    writeFileSync(join(dir, `content/landing/${loc}`, `${name}.md`), content);
  };

  beforeEach(() => {
    page('de', 'planen', '---\nslug: planen\nalternate: party\n---\nS');
    page('de', 'ideen', '---\nslug: ideen\nalternate: ceremony\n---\nM');
    page('de', 'lonely', '---\nslug: lonely\n---\nL');
    page('de', 'other', '---\nslug: other\nrelated_pages:\n  - ideen\n---\nO');
    page('en', 'party', '---\nslug: party\nalternate: planen\n---\nS');
    page('en', 'ceremony', '---\nslug: ceremony\nalternate: ideen\n---\nM');
    page('en', 'en-other', '---\nslug: en-other\nrelated_pages:\n  - ceremony\n  - x\n---\nO');
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/redirects.json'), JSON.stringify({ old: 'ceremony' }));
  });

  it('deletes the merged counterpart, redirects it to the survivor counterpart and repoints en related pages', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen'], config: EN_CONFIG, cwd: dir });
    const byPath = Object.fromEntries(files.map(f => [f.path, f]));

    expect(byPath['content/landing/de/ideen.md'].delete).toBe(true);
    expect(byPath['content/landing/en/ceremony.md'].delete).toBe(true);
    expect(JSON.parse(byPath['seo/redirects.json'].content)).toEqual({ old: 'party', ideen: 'planen', ceremony: 'party' });
    expect(byPath['content/landing/en/en-other.md'].content).toContain('  - party\n  - x');
  });

  it('redirects to the survivor DE slug when the survivor has no counterpart', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    page('de', 'planen', '---\nslug: planen\n---\nS');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen'], config: EN_CONFIG, cwd: dir });
    const redirects = JSON.parse(files.find(f => f.path === 'seo/redirects.json').content);

    expect(redirects.ceremony).toBe('planen');
  });

  it('leaves a merged page without alternate alone', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['lonely'], config: EN_CONFIG, cwd: dir });

    expect(files.filter(f => f.delete).map(f => f.path)).toEqual(['content/landing/de/lonely.md']);
  });

  it('ignores an alternate that is not a slug', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    page('de', 'ideen', '---\nslug: ideen\nalternate: ../de/planen\n---\nM');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen'], config: EN_CONFIG, cwd: dir });

    expect(files.filter(f => f.delete).map(f => f.path)).toEqual(['content/landing/de/ideen.md']);
  });

  it('never deletes the survivor counterpart and handles a shared alternate once', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    page('de', 'ideen', '---\nslug: ideen\nalternate: party\n---\nM');
    page('de', 'zwei', '---\nslug: zwei\nalternate: ceremony\n---\nM');
    page('de', 'drei', '---\nslug: drei\nalternate: ceremony\n---\nM');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen', 'zwei', 'drei'], config: EN_CONFIG, cwd: dir });
    const deletes = files.filter(f => f.delete).map(f => f.path);

    expect(deletes).not.toContain('content/landing/en/party.md');
    expect(deletes.filter(p => p === 'content/landing/en/ceremony.md')).toHaveLength(1);
    expect(JSON.parse(files.find(f => f.path === 'seo/redirects.json').content).party).toBeUndefined();
  });

  it('drops the deleted counterpart from en related_pages when the survivor has none', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    page('de', 'planen', '---\nslug: planen\n---\nS');
    const { files } = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen'], config: EN_CONFIG, cwd: dir });

    expect(files.find(f => f.path === 'content/landing/en/en-other.md').content).toBe('---\nslug: en-other\nrelated_pages:\n  - x\n---\nO');
  });

  it('deletes a prefixed counterpart without a redirect and reports it', async () => {
    const { buildMergeFiles } = await import('../src/lib/landings.js');
    const res = buildMergeFiles({ survivor: 'planen', mergeFrom: ['ideen'], config: { ...EN_CONFIG, counterpart_url_prefix: '/en' }, cwd: dir });
    const redirects = JSON.parse(res.files.find(f => f.path === 'seo/redirects.json').content);

    expect(res.files.find(f => f.path === 'content/landing/en/ceremony.md').delete).toBe(true);
    expect(redirects.ceremony).toBeUndefined();
    expect(redirects.old).toBe('ceremony');
    expect(res.counterparts).toMatchObject([{ slug: 'ceremony', manualRedirect: true }]);
  });
});
