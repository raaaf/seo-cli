import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Orchestration of `seo run`: reconcile, pipeline, state commits around the PRs,
// run report. The heavy collaborators (discover/generate/validate/pr/track, config
// load, GitHub) are mocked. Closes the largest Needs-human-review gap.

const discover = vi.fn();
const generatePage = vi.fn();
const generateCounterpart = vi.fn();
const validate = vi.fn();
const createPRs = vi.fn();
const prepareImprove = vi.fn();
const publishImprove = vi.fn();
const track = vi.fn();
const reviewPage = vi.fn();
const commitState = vi.fn();
const getPR = vi.fn();
const deleteBranch = vi.fn();
const getLlmStats = vi.fn();

const CONFIG = {
  project: 'demo', locale: 'de', locales: ['de'], score_cutoff: 7,
  weekly_cap: 2, landing_path: 'resources/landing/de/', repo: 'o/demo',
};

vi.mock('../src/steps/discover.js', () => ({ discover: (...a) => discover(...a) }));
vi.mock('../src/steps/generate.js', () => ({ generatePage: (...a) => generatePage(...a) }));
// linkAlternates is pure and already unit-tested in counterpart.test.js — keep the
// real implementation here, only the network-calling generateCounterpart is mocked.
vi.mock('../src/steps/counterpart.js', async (orig) => ({
  ...(await orig()), generateCounterpart: (...a) => generateCounterpart(...a),
}));
vi.mock('../src/steps/validate.js', () => ({ validate: (...a) => validate(...a) }));
// The fact checker calls the API with web search; the pipeline test only cares
// that the page survives it untouched.
vi.mock('../src/commands/improve.js', () => ({
  prepareImprove: (...a) => prepareImprove(...a),
  publishImprove: (...a) => publishImprove(...a),
}));
vi.mock('../src/steps/review.js', () => ({
  reviewPage: (...a) => reviewPage(...a),
  unresolvedSeverity: () => null,
}));
vi.mock('../src/steps/pr.js', () => ({ createPRs: (...a) => createPRs(...a) }));
vi.mock('../src/lib/state.js', () => ({ commitState: (...a) => commitState(...a) }));
vi.mock('../src/lib/github.js', () => ({ getPR: (...a) => getPR(...a), deleteBranch: (...a) => deleteBranch(...a) }));
vi.mock('../src/lib/claude.js', () => ({ getLlmStats: () => getLlmStats() }));
vi.mock('../src/steps/track.js', () => ({ track: (...a) => track(...a) }));
vi.mock('../src/lib/config.js', async (orig) => ({ ...(await orig()), loadConfig: () => CONFIG }));

const { runCommand } = await import('../src/commands/run.js');
const { loadKeywords, loadSitemapPending } = await import('../src/lib/keywords.js');
const { loadImprovements } = await import('../src/lib/improvements.js');
const { BudgetExceededError } = await import('../src/lib/budget.js');

const REQUIRED = ['ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SERPAPI_KEY', 'GITHUB_TOKEN'];
let dir, cwd, saved, logs, reportPath;

function keywordsData() {
  return { keywords: [{ keyword: 'hochzeit planen', status: 'proposed', score: 9, target_slug: 'hochzeit-planen', type: 'guide' }] };
}

const opened = (url, slug = 'hochzeit-planen') => ({ prs: [{ url, keyword: 'hochzeit planen', slug }], warnings: [], errors: [] });
const report = () => JSON.parse(readFileSync(reportPath, 'utf8'));
const run = (opts = {}) => runCommand({ report: reportPath, ...opts });

function seedState(file, data) {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, 'seo', file), JSON.stringify(data));
}

function manyKeywords(n) {
  return { keywords: Array.from({ length: n }, (_, i) => ({ keyword: `kw ${i}`, status: 'proposed', score: 9, target_slug: `slug-${i}`, type: 'guide' })) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-run-'));
  cwd = process.cwd();
  process.chdir(dir);
  saved = {};
  for (const k of REQUIRED) { saved[k] = process.env[k]; process.env[k] = 'x'; }
  reportPath = join(dir, 'report.json');
  for (const fn of [discover, generatePage, generateCounterpart, validate, createPRs, prepareImprove, publishImprove, track, commitState, getPR, deleteBranch, reviewPage]) fn.mockReset();
  getLlmStats.mockReset();
  getLlmStats.mockReturnValue({ subscription_calls: 0, api_calls: 0, usd_equivalent: 0, fallbacks: [] });
  commitState.mockResolvedValue([]);
  deleteBranch.mockResolvedValue();
  createPRs.mockResolvedValue({ prs: [], warnings: [], errors: [] });
  reviewPage.mockImplementation(async (markdown) => ({ markdown, findings: [] }));
  generatePage.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
  validate.mockReturnValue({ ok: true, errors: [], warnings: [] });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => {
  process.chdir(cwd);
  for (const k of REQUIRED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('run-pipeline', () => {
  it('runs discover → generate → state → PRs → state → track', async () => {
    discover.mockResolvedValue(keywordsData());
    const order = [];
    commitState.mockImplementation(async () => { order.push('state'); return []; });
    createPRs.mockImplementation(async () => { order.push('prs'); return opened('https://github.com/o/demo/pull/1'); });
    track.mockImplementation(async () => { order.push('track'); });

    await run();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(generatePage).toHaveBeenCalledTimes(1);
    const prArg = createPRs.mock.calls[0][0];
    expect(prArg.generatedPages).toHaveLength(1);
    expect(prArg.generatedPages[0].slug).toBe('hochzeit-planen');
    expect(order).toEqual(['state', 'prs', 'track', 'state']);
    expect(commitState.mock.calls[0][0]).toMatchObject({ repo: 'o/demo', cwd: process.cwd() });
  });

  it('commits the generated keyword as proposed before the PRs, and as pr_opened with its pr_url after', async () => {
    discover.mockResolvedValue(keywordsData());
    let beforePRs;
    commitState.mockImplementationOnce(async () => { beforePRs = loadKeywords(dir).keywords[0]; return []; });
    createPRs.mockImplementation(async ({ keywordsData: kd }) => {
      Object.assign(kd.keywords[0], { status: 'pr_opened', pr_url: 'https://github.com/o/demo/pull/1' }); // what pr.js does
      return opened('https://github.com/o/demo/pull/1');
    });

    await run();

    expect(beforePRs.status).toBe('proposed');
    expect(loadKeywords(dir).keywords[0]).toMatchObject({ status: 'pr_opened', pr_url: 'https://github.com/o/demo/pull/1' });
  });

  it('sets keywords whose PR failed back to proposed in the final state', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    createPRs.mockImplementation(async ({ keywordsData: kd }) => {
      kd.keywords[0].status = 'proposed'; // what pr.js does for a failed PR
      return { prs: [], warnings: [], errors: ['PR creation failed for "hochzeit planen": GitHub 500'] };
    });

    await run();

    expect(loadKeywords(dir).keywords[0].status).toBe('proposed');
    expect(report()).toMatchObject({ status: 'failed', prs: [], errors: [expect.stringMatching(/GitHub 500/)] });
  });

  it('skips PR and track on --dry-run, with no reconcile and no state commit, but still reports', async () => {
    discover.mockResolvedValue(keywordsData());
    await run({ dryRun: true });
    expect(createPRs).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(commitState).not.toHaveBeenCalled();
    expect(getPR).not.toHaveBeenCalled();
    expect(report().status).toBe('idle');
  });

  it('retries generation once with validator feedback after a failed validation', async () => {
    discover.mockResolvedValue(keywordsData());
    createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/2'));
    validate.mockReset();
    validate
      .mockReturnValueOnce({ ok: false, errors: ['Body too short: 10 words (min 800)'], warnings: [] })
      .mockReturnValue({ ok: true, errors: [], warnings: [] });

    await run();

    expect(generatePage).toHaveBeenCalledTimes(2);
    // second attempt receives the failed validation result as feedback (4th arg)
    expect(generatePage.mock.calls[1][3]).toMatchObject({ ok: false });
    expect(createPRs.mock.calls[0][0].generatedPages).toHaveLength(1);
  });

  it('drops a page whose fact check did not run and keeps the keyword proposed', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    reviewPage.mockImplementation(async (markdown) => ({ markdown, findings: [], unchecked: true, error: 'Claude returned no JSON:' }));

    await run();

    expect(logs.join('\n')).toMatch(/fact check did not run: Claude returned no JSON/);
    expect(data.keywords[0].status).toBe('proposed');
    expect(createPRs).not.toHaveBeenCalled();
  });

  it('marks a keyword validation_failed after two failed attempts and opens no PR', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    validate.mockReset();
    validate.mockReturnValue({ ok: false, errors: ['Body too short'], warnings: [] });

    await run();

    expect(generatePage).toHaveBeenCalledTimes(2);
    expect(data.keywords[0].status).toBe('validation_failed');
    expect(createPRs).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(1); // tracking still runs
  });

  it('never runs more than the concurrency cap (2) of generations at once', async () => {
    CONFIG.weekly_cap = 4;
    try {
      discover.mockResolvedValue(manyKeywords(4));
      createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/3'));
      let active = 0;
      let maxActive = 0;
      generatePage.mockReset();
      generatePage.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        return '---\nslug: x\n---\nbody';
      });

      await run();

      expect(maxActive).toBeLessThanOrEqual(2);
      expect(createPRs.mock.calls[0][0].generatedPages).toHaveLength(4);
    } finally {
      CONFIG.weekly_cap = 2;
    }
  });

  it('generates a reciprocal counterpart page and links alternates on both pages', async () => {
    CONFIG.counterpart_locale = 'en';
    try {
      discover.mockResolvedValue(keywordsData());
      createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/4'));
      generateCounterpart.mockResolvedValue({ markdown: '---\nslug: wedding-planning\n---\nbody', slug: 'wedding-planning' });

      await run();

      const pages = createPRs.mock.calls[0][0].generatedPages;
      expect(pages).toHaveLength(2);

      const dePage = pages.find(p => p.locale === 'de');
      const enPage = pages.find(p => p.locale === 'en');
      expect(dePage.markdown).toContain('alternate: wedding-planning');
      expect(enPage.slug).toBe('wedding-planning');
      expect(enPage.markdown).toContain('alternate: hochzeit-planen');
      expect(enPage.filePath).toBe('resources/landing/en/wedding-planning.md');
    } finally {
      delete CONFIG.counterpart_locale;
    }
  });

  it('rejects a counterpart whose steps count differs from the source page', async () => {
    CONFIG.counterpart_locale = 'en';
    try {
      const data = keywordsData();
      discover.mockResolvedValue(data);
      generatePage.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
      generateCounterpart.mockResolvedValue({
        markdown: '---\nslug: wedding-planning\nsteps:\n  - a\n  - b\n---\nbody',
        slug: 'wedding-planning',
      });

      await run();

      expect(generateCounterpart).toHaveBeenCalledTimes(2);
      expect(createPRs).not.toHaveBeenCalled();
      expect(logs.join('\n')).toMatch(/steps count differs from the source page: 2 instead of 0/);
      expect(generateCounterpart.mock.calls[1][4].validatorFeedback).toMatch(/steps count differs/);
    } finally {
      delete CONFIG.counterpart_locale;
    }
  });

  it('drops the default-locale page too when its counterpart fails, and leaves the keyword for next run', async () => {
    CONFIG.counterpart_locale = 'en';
    try {
      const data = keywordsData();
      discover.mockResolvedValue(data);
      generateCounterpart.mockRejectedValue(new Error('Counterpart generation failed: slug collides'));

      await run();

      expect(createPRs).not.toHaveBeenCalled();
      expect(data.keywords[0].status).toBe('proposed');
      expect(logs.join('\n')).toMatch(/Counterpart skipped/);
      expect(logs.join('\n')).toMatch(/the pair ships together or not at all/);
      expect(data.keywords[0].counterpart_failures).toBe(1);
    } finally {
      delete CONFIG.counterpart_locale;
    }
  });
});

describe('counterpart failure limit', () => {
  it('marks the keyword validation_failed with a note when its counterpart failed in a second run', async () => {
    CONFIG.counterpart_locale = 'en';
    try {
      const data = keywordsData();
      data.keywords[0].counterpart_failures = 1;
      discover.mockResolvedValue(data);
      generateCounterpart.mockRejectedValue(new Error('Counterpart generation failed: slug collides'));

      await run();

      expect(createPRs).not.toHaveBeenCalled();
      expect(data.keywords[0].status).toBe('validation_failed');
      expect(data.keywords[0].counterpart_failures).toBe(2);
      expect(data.keywords[0].note).toMatch(/en counterpart failed/);
    } finally {
      delete CONFIG.counterpart_locale;
    }
  });

  it('clears the failure counter when the pair ships', async () => {
    CONFIG.counterpart_locale = 'en';
    try {
      const data = keywordsData();
      data.keywords[0].counterpart_failures = 1;
      discover.mockResolvedValue(data);
      generateCounterpart.mockResolvedValue({ markdown: '---\nslug: wedding-planning\n---\nbody', slug: 'wedding-planning' });
      createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/5'));

      await run();

      expect(data.keywords[0]).not.toHaveProperty('counterpart_failures');
    } finally {
      delete CONFIG.counterpart_locale;
    }
  });
});

describe('empty backlog', () => {
  it('improves an existing page instead of generating a new one, as its own PR', async () => {
    discover.mockResolvedValue({ version: 1, keywords: [] });
    const prepared = { slug: 'preise', files: [], record: {}, prTitle: 't', prBody: 'b' };
    prepareImprove.mockResolvedValue(prepared);
    publishImprove.mockResolvedValue('https://github.com/o/demo/pull/8');

    await run();

    expect(createPRs).not.toHaveBeenCalled();
    expect(publishImprove).toHaveBeenCalledWith(prepared, expect.objectContaining({ config: CONFIG, cwd: process.cwd() }));
    expect(report()).toMatchObject({ status: 'prs_opened', prs: [{ url: 'https://github.com/o/demo/pull/8', kind: 'improve', slug: 'preise' }] });
  });

  it('is idle when no page qualifies for a rewrite', async () => {
    discover.mockResolvedValue({ version: 1, keywords: [] });
    prepareImprove.mockResolvedValue(null);

    await run();

    expect(publishImprove).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ status: 'idle', prs: [], errors: [] });
  });

  it('reports a skipped improve (branch exists) as a warning, not as an error', async () => {
    discover.mockResolvedValue({ version: 1, keywords: [] });
    prepareImprove.mockResolvedValue({ slug: 'preise' });
    publishImprove.mockImplementation(async (_p, { warnings }) => { warnings.push('Improve skipped: branch exists'); return null; });

    await run();

    expect(report()).toMatchObject({ status: 'idle', warnings: ['Improve skipped: branch exists'], errors: [] });
  });
});

describe('run-reconcile', () => {
  const PR = (n) => `https://github.com/o/demo/pull/${n}`;
  const kw = (keyword, n, extra = {}) => ({ keyword, status: 'pr_opened', score: 9, target_slug: keyword, pr_url: PR(n), sitemap_slugs: [`/${keyword}`], ...extra });

  beforeEach(() => {
    discover.mockImplementation(async () => loadKeywords(dir));
    prepareImprove.mockResolvedValue(null);
  });

  it('publishes a merged keyword, rejects a closed one, leaves an open one, and queues sitemap slugs only for the merged one', async () => {
    seedState('keywords.json', { version: 1, keywords: [kw('merged', 1), kw('closed', 2), kw('open', 3)] });
    getPR.mockImplementation(async ({ url }) => ({ state: { [PR(1)]: 'merged', [PR(2)]: 'closed', [PR(3)]: 'open' }[url], mergedAt: null }));

    await run();

    const status = Object.fromEntries(loadKeywords(dir).keywords.map(k => [k.keyword, k.status]));
    expect(status).toEqual({ merged: 'published', closed: 'rejected', open: 'pr_opened' });
    expect(loadSitemapPending(dir).slugs).toEqual(['/merged']);
  });

  it('deletes the branch of a keyword PR that was closed without merge, and only that one', async () => {
    seedState('keywords.json', { version: 1, keywords: [kw('closed', 2), kw('open', 3)] });
    getPR.mockImplementation(async ({ url }) => (url === PR(2) ? { state: 'closed', headRef: 'seo/new/closed' } : { state: 'open', headRef: 'seo/new/open' }));

    await run();

    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith({ repo: 'o/demo', branch: 'seo/new/closed' });
  });

  it('deletes the branch of an improvement PR that was closed without merge', async () => {
    seedState('improvements.json', { version: 1, entries: [{ slug: 'p', date: '2026-10-01', pr_url: PR(5) }] });
    getPR.mockResolvedValue({ state: 'closed', headRef: 'seo/improve/p' });

    await run();

    expect(deleteBranch).toHaveBeenCalledWith({ repo: 'o/demo', branch: 'seo/improve/p' });
  });

  it('reconciles before discover reads the keywords', async () => {
    seedState('keywords.json', { version: 1, keywords: [kw('merged', 1)] });
    getPR.mockResolvedValue({ state: 'merged', mergedAt: null });
    discover.mockImplementation(async () => { expect(loadKeywords(dir).keywords[0].status).toBe('published'); return { version: 1, keywords: [] }; });

    await run();

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('does not touch a pr_opened keyword that has no stored PR url', async () => {
    seedState('keywords.json', { version: 1, keywords: [kw('legacy', 1, { pr_url: undefined })] });

    await run();

    expect(getPR).not.toHaveBeenCalled();
    expect(loadKeywords(dir).keywords[0].status).toBe('pr_opened');
  });

  it('keeps the status and warns when a PR cannot be read', async () => {
    seedState('keywords.json', { version: 1, keywords: [kw('flaky', 1)] });
    getPR.mockRejectedValue(new Error('GitHub 502'));

    await run();

    expect(loadKeywords(dir).keywords[0].status).toBe('pr_opened');
    expect(report().warnings[0]).toMatch(/Could not read .*GitHub 502/);
  });

  it('drops the cooldown entry of a closed improvement PR and keeps a merged one with its merge date', async () => {
    seedState('improvements.json', { version: 1, entries: [
      { slug: 'closed-page', date: '2026-10-01', pr_url: PR(5) },
      { slug: 'merged-page', date: '2026-10-01', pr_url: PR(6) },
      { slug: 'open-page', date: '2026-10-01', pr_url: PR(7) },
      { slug: 'old-page', date: '2026-08-01' },
    ] });
    getPR.mockImplementation(async ({ url }) => ({ state: { [PR(5)]: 'closed', [PR(6)]: 'merged', [PR(7)]: 'open' }[url], mergedAt: '2026-10-03T09:00:00Z' }));

    await run();

    const entries = loadImprovements(dir).entries;
    expect(entries.map(e => e.slug)).toEqual(['merged-page', 'open-page', 'old-page']);
    expect(entries[0].merged_at).toBe('2026-10-03T09:00:00Z');
    expect(entries[1].merged_at).toBeUndefined();
  });

  it('persists merged_at when a merged improvement PR is the only change', async () => {
    seedState('improvements.json', { version: 1, entries: [{ slug: 'merged-page', date: '2026-10-01', pr_url: PR(6) }] });
    getPR.mockResolvedValue({ state: 'merged', mergedAt: '2026-10-03T09:00:00Z' });

    await run();

    expect(JSON.parse(readFileSync(join(dir, 'seo', 'improvements.json'), 'utf8')).entries[0].merged_at).toBe('2026-10-03T09:00:00Z');
  });

  it('does not ask GitHub again about an improvement that is already merged', async () => {
    seedState('improvements.json', { version: 1, entries: [{ slug: 'p', date: '2026-10-01', pr_url: PR(6), merged_at: '2026-10-02' }] });

    await run();

    expect(getPR).not.toHaveBeenCalled();
  });
});

describe('run-report', () => {
  it('reports the opened PRs, the budget and exits normally', async () => {
    discover.mockResolvedValue(keywordsData());
    createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/1'));

    await run();

    expect(report()).toMatchObject({
      status: 'prs_opened',
      prs: [{ url: 'https://github.com/o/demo/pull/1', kind: 'new', slug: 'hochzeit-planen' }],
      budget: { serpapi: { used: 0, limit: 60 }, anthropic: { usd: 0, limit_usd: 30 } },
      warnings: [], errors: [],
    });
  });

  it('puts the LLM stats in the report without a warning when nothing fell back', async () => {
    const llm = { subscription_calls: 4, api_calls: 0, usd_equivalent: 1.2, fallbacks: [] };
    getLlmStats.mockReturnValue(llm);
    discover.mockResolvedValue({ keywords: [] });
    await run();
    expect(report().llm).toEqual(llm);
    expect(report().warnings).toEqual([]);
  });

  it('warns when a call fell back to the API', async () => {
    getLlmStats.mockReturnValue({ subscription_calls: 1, api_calls: 1, usd_equivalent: 1, fallbacks: [{ model: 'm', kind: 'limit', reason: 'x' }] });
    discover.mockResolvedValue({ keywords: [] });
    await run();
    expect(report().warnings).toEqual([expect.stringMatching(/fell back from the subscription to the API \(limit\)/)]);
  });

  it('warns when subscription usage is worth more than 25 USD', async () => {
    getLlmStats.mockReturnValue({ subscription_calls: 30, api_calls: 0, usd_equivalent: 25.5, fallbacks: [] });
    discover.mockResolvedValue({ keywords: [] });
    await run();
    expect(report().warnings).toEqual([expect.stringMatching(/25\.50 USD/)]);
  });

  it('ends with status budget_exceeded and does not throw', async () => {
    discover.mockRejectedValue(new BudgetExceededError('Anthropic monthly budget exhausted'));

    await expect(run()).resolves.toBeUndefined();

    expect(report()).toMatchObject({ status: 'budget_exceeded', errors: ['Anthropic monthly budget exhausted'] });
    expect(createPRs).not.toHaveBeenCalled();
  });

  it('waits for sibling generations before committing state when one hits the budget', async () => {
    discover.mockResolvedValue(manyKeywords(2));
    let siblingDone = false;
    generatePage
      .mockRejectedValueOnce(new BudgetExceededError('Anthropic monthly budget exhausted'))
      .mockImplementationOnce(async () => { await new Promise(r => setTimeout(r, 30)); siblingDone = true; return '---\nslug: slug-1\n---\nbody'; });
    let doneAtCommit;
    commitState.mockImplementation(async () => { doneAtCommit = siblingDone; return []; });

    await run();

    expect(doneAtCommit).toBe(true);
    expect(report().status).toBe('budget_exceeded');
  });

  it('still commits state and writes the report when the run fails, then rethrows', async () => {
    discover.mockRejectedValue(new Error('GSC down'));

    await expect(run()).rejects.toThrow('GSC down');

    expect(commitState).toHaveBeenCalledTimes(1);
    expect(commitState.mock.calls[0][0].reason).toMatch(/results/);
    expect(report()).toMatchObject({ status: 'failed', errors: ['GSC down'] });
  });

  it('releases keywords marked for a PR that never got one when the state commit fails', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    commitState.mockRejectedValueOnce(new Error('GitHub 500')).mockResolvedValue([]);

    await expect(run()).rejects.toThrow('GitHub 500');

    expect(createPRs).not.toHaveBeenCalled();
    expect(loadKeywords(dir).keywords[0].status).toBe('proposed');
    expect(commitState).toHaveBeenCalledTimes(2);
  });

  it('survives a failing final state commit and reports it as a warning', async () => {
    discover.mockResolvedValue(keywordsData());
    createPRs.mockResolvedValue(opened('https://github.com/o/demo/pull/1'));
    commitState.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('GitHub 500'));

    await run();

    expect(report()).toMatchObject({ status: 'prs_opened', warnings: [expect.stringMatching(/State commit after the run failed: GitHub 500/)] });
  });
});
