import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// serpapi.js resolves QUOTA_FILE and memoizes quota state at module scope,
// so each test gets a fresh module via resetModules + dynamic import.
let dir;

vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

async function freshModule() {
  vi.resetModules();
  const safeFetchMod = await import('../src/lib/safe-fetch.js');
  const serpapi = await import('../src/lib/serpapi.js');
  return { serpapi, safeFetch: safeFetchMod.safeFetch };
}

function serpOk() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ organic_results: [{ title: 't', snippet: 's' }] }),
  });
}

function quotaOnDisk() {
  return JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'));
}

const month = new Date().toISOString().slice(0, 7);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'serpapi-test-'));
  process.env.SEO_CLI_QUOTA_FILE = join(dir, 'quota.json');
  process.env.SERPAPI_KEY = 'test-key';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SEO_CLI_QUOTA_FILE;
  vi.clearAllMocks();
});

describe('serpapi quota', () => {
  it('starts a fresh month at 0/240', async () => {
    const { serpapi } = await freshModule();
    const q = serpapi.checkQuota();
    expect(q.used).toBe(0);
    expect(q.remaining).toBe(240);
    expect(q.month).toBe(month);
  });

  it('resets when the stored month differs', async () => {
    writeFileSync(process.env.SEO_CLI_QUOTA_FILE, JSON.stringify({ month: '2020-01', used: 200 }));
    const { serpapi } = await freshModule();
    expect(serpapi.checkQuota().remaining).toBe(240);
  });

  it('migrates old weekly quota files, keeping the count', async () => {
    writeFileSync(process.env.SEO_CLI_QUOTA_FILE, JSON.stringify({ week: '2026-W24', used: 37 }));
    const { serpapi } = await freshModule();
    const q = serpapi.checkQuota();
    expect(q.used).toBe(37);
    expect(q.month).toBe(month);
  });

  it('increments quota on a successful search', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockImplementation(serpOk);
    await serpapi.getSerp('test keyword');
    expect(quotaOnDisk()).toEqual({ month, used: 1 });
  });

  it('refunds quota when the request fails', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockRejectedValue(new Error('network down'));
    await expect(serpapi.getSerp('kw')).rejects.toThrow('network down');
    expect(quotaOnDisk()).toEqual({ month, used: 0 });
  });

  it('refunds quota on non-2xx responses', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue({ ok: false, status: 429 });
    await expect(serpapi.getSerp('kw')).rejects.toThrow('SerpAPI error: 429');
    expect(quotaOnDisk()).toEqual({ month, used: 0 });
  });

  it('refunds failed calls even in a parallel burst (rollback race)', async () => {
    const { serpapi, safeFetch } = await freshModule();
    // 4 parallel calls: two succeed, two fail. Net count must be exactly 2.
    let n = 0;
    safeFetch.mockImplementation(() => {
      n++;
      return n % 2 === 0 ? Promise.reject(new Error('boom')) : serpOk();
    });
    const results = await Promise.allSettled([
      serpapi.getSerp('a'), serpapi.getSerp('b'), serpapi.getSerp('c'), serpapi.getSerp('d'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(quotaOnDisk()).toEqual({ month, used: 2 });
  });

  it('hard-stops at the monthly limit', async () => {
    writeFileSync(process.env.SEO_CLI_QUOTA_FILE, JSON.stringify({ month, used: 240 }));
    const { serpapi, safeFetch } = await freshModule();
    await expect(serpapi.getSerp('kw')).rejects.toThrow(/monthly quota exhausted/);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
