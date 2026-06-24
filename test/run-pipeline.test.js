import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// End-to-end happy path + PR-failure rollback for `seo run`, with the heavy
// collaborators (discover/generate/validate/pr/track, config load, state save)
// mocked. Closes the largest Needs-human-review gap (run orchestration).

const discover = vi.fn();
const generatePage = vi.fn();
const validate = vi.fn();
const createPR = vi.fn();
const track = vi.fn();
const saveKeywords = vi.fn();
const saveLastPR = vi.fn();

const CONFIG = {
  project: 'demo', locale: 'de', locales: ['de'], score_cutoff: 7,
  weekly_cap: 2, landing_path: 'resources/landing/de/', repo: 'o/demo',
};

vi.mock('../src/steps/discover.js', () => ({ discover: (...a) => discover(...a) }));
vi.mock('../src/steps/generate.js', () => ({ generatePage: (...a) => generatePage(...a) }));
vi.mock('../src/steps/validate.js', () => ({ validate: (...a) => validate(...a) }));
vi.mock('../src/steps/pr.js', () => ({ createPR: (...a) => createPR(...a) }));
vi.mock('../src/steps/track.js', () => ({ track: (...a) => track(...a) }));
vi.mock('../src/lib/config.js', async (orig) => ({ ...(await orig()), loadConfig: () => CONFIG }));
vi.mock('../src/lib/keywords.js', async (orig) => ({
  ...(await orig()), saveKeywords: (...a) => saveKeywords(...a), saveLastPR: (...a) => saveLastPR(...a),
}));

const { runCommand } = await import('../src/commands/run.js');

const REQUIRED = ['ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SERPAPI_KEY', 'GITHUB_TOKEN'];
let dir, cwd, saved, logs;

function keywordsData() {
  return { keywords: [{ keyword: 'hochzeit planen', status: 'proposed', score: 9, target_slug: 'hochzeit-planen', type: 'guide' }] };
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
  for (const fn of [discover, generatePage, validate, createPR, track, saveKeywords, saveLastPR]) fn.mockReset();
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
  it('runs discover → generate → pr → track and records the PR url', async () => {
    discover.mockResolvedValue(keywordsData());
    createPR.mockResolvedValue('https://github.com/o/demo/pull/1');

    await runCommand({});

    expect(discover).toHaveBeenCalledTimes(1);
    expect(generatePage).toHaveBeenCalledTimes(1);
    const prArg = createPR.mock.calls[0][0];
    expect(prArg.generatedPages).toHaveLength(1);
    expect(prArg.generatedPages[0].slug).toBe('hochzeit-planen');
    expect(saveLastPR).toHaveBeenCalledWith('https://github.com/o/demo/pull/1', expect.any(String));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('rolls keyword status back to proposed when PR creation fails', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    createPR.mockRejectedValue(new Error('GitHub 500'));

    await runCommand({});

    expect(logs.join('\n')).toMatch(/PR creation failed/);
    expect(data.keywords[0].status).toBe('proposed'); // reset for retry next run
    expect(saveLastPR).not.toHaveBeenCalled();
  });

  it('skips PR and track on --dry-run', async () => {
    discover.mockResolvedValue(keywordsData());
    await runCommand({ dryRun: true });
    expect(createPR).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('retries generation once with validator feedback after a failed validation', async () => {
    discover.mockResolvedValue(keywordsData());
    createPR.mockResolvedValue('https://github.com/o/demo/pull/2');
    validate.mockReset();
    validate
      .mockReturnValueOnce({ ok: false, errors: ['Body too short: 10 words (min 800)'], warnings: [] })
      .mockReturnValue({ ok: true, errors: [], warnings: [] });

    await runCommand({});

    expect(generatePage).toHaveBeenCalledTimes(2);
    // second attempt receives the failed validation result as feedback (4th arg)
    expect(generatePage.mock.calls[1][3]).toMatchObject({ ok: false });
    expect(createPR.mock.calls[0][0].generatedPages).toHaveLength(1);
  });

  it('marks a keyword validation_failed after two failed attempts and opens no PR', async () => {
    const data = keywordsData();
    discover.mockResolvedValue(data);
    validate.mockReset();
    validate.mockReturnValue({ ok: false, errors: ['Body too short'], warnings: [] });

    await runCommand({});

    expect(generatePage).toHaveBeenCalledTimes(2);
    expect(data.keywords[0].status).toBe('validation_failed');
    expect(createPR).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(1); // tracking still runs
  });

  it('never runs more than the concurrency cap (2) of generations at once', async () => {
    CONFIG.weekly_cap = 4;
    try {
      discover.mockResolvedValue(manyKeywords(4));
      createPR.mockResolvedValue('https://github.com/o/demo/pull/3');
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

      await runCommand({});

      expect(maxActive).toBeLessThanOrEqual(2);
      expect(createPR.mock.calls[0][0].generatedPages).toHaveLength(4);
    } finally {
      CONFIG.weekly_cap = 2;
    }
  });
});
