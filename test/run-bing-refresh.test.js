import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// `seo run` refreshes the Bing queries only when discover will use them this run.

const refresh = vi.fn();
const discover = vi.fn();
const loadCatalog = vi.fn();
const CONFIG = { project: 'demo', locale: 'de', locales: ['de'], score_cutoff: 7, weekly_cap: 2, max_new_pages_per_month: 4, landing_path: 'resources/landing/de/', repo: 'o/demo', bing: { enabled: true } };

vi.mock('../src/lib/signals/bing.js', async (orig) => ({ ...(await orig()), refreshBingQueries: (...a) => refresh(...a) }));
vi.mock('../src/lib/catalog.js', async (orig) => ({ ...(await orig()), loadCatalog: (...a) => loadCatalog(...a) }));
vi.mock('../src/steps/discover.js', () => ({ discover: (...a) => discover(...a) }));
vi.mock('../src/steps/measure.js', () => ({ measure: async () => ({ entries: 0, due: 0, measured: 0, changed: [] }) }));
vi.mock('../src/steps/assess.js', () => ({ assessAlerts: async () => [] }));
vi.mock('../src/commands/improve.js', () => ({ prepareImprove: async () => null, publishImprove: vi.fn() }));
vi.mock('../src/lib/state.js', () => ({ commitState: async () => [] }));
vi.mock('../src/lib/github.js', () => ({ getPR: vi.fn(), deleteBranch: vi.fn() }));
vi.mock('../src/lib/claude.js', () => ({ getLlmStats: () => ({ subscription_calls: 0, api_calls: 0, usd_equivalent: 0, fallbacks: [] }) }));
vi.mock('../src/lib/config.js', async (orig) => ({ ...(await orig()), loadConfig: () => CONFIG }));

const { runCommand } = await import('../src/commands/run.js');

const REQUIRED = ['ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SERPAPI_KEY', 'GITHUB_TOKEN'];
let dir, cwd, saved;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-run-bing-'));
  cwd = process.cwd();
  process.chdir(dir);
  saved = {};
  for (const k of REQUIRED) { saved[k] = process.env[k]; process.env[k] = 'x'; }
  refresh.mockReset();
  discover.mockReset().mockResolvedValue({ keywords: [] });
  loadCatalog.mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(cwd);
  for (const k of REQUIRED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('run: Bing refresh', () => {
  it('refreshes when discover runs', async () => {
    await runCommand({ dryRun: true });
    expect(discover).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh while the catalog is down', async () => {
    loadCatalog.mockRejectedValue(new Error('shop down'));
    await runCommand({ dryRun: true });
    expect(discover).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
