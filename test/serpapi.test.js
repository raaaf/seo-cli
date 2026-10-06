import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// serpapi.js memoizes the account.json read at module scope, so each test gets
// a fresh module via resetModules + dynamic import. The project budget lives
// in seo/budget.json under cwd, which is pointed at a temp dir.
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

function accountJson(left) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ total_searches_left: left }) });
}

// Routes account.json to the given account state and every other URL to `search`.
function route(safeFetch, { left = 1000, search = serpOk } = {}) {
  safeFetch.mockImplementation((url) => (String(url).includes('account.json') ? accountJson(left) : search()));
}

function searchCalls(safeFetch) {
  return safeFetch.mock.calls.filter(([url]) => String(url).includes('search.json'));
}

function budgetOnDisk() {
  return JSON.parse(readFileSync(join(dir, 'seo', 'budget.json'), 'utf8'));
}

function seedBudget(used) {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, 'seo', 'budget.json'), JSON.stringify({ month, serpapi: { used }, anthropic: { usd: 0, calls: 0 } }));
}

const month = new Date().toISOString().slice(0, 7);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'serpapi-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  process.env.SERPAPI_KEY = 'test-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('serpapi-quota: quota', () => {
  it('starts a fresh month at 0/60', async () => {
    const { serpapi } = await freshModule();
    const q = serpapi.checkQuota();
    expect(q.used).toBe(0);
    expect(q.remaining).toBe(60);
    expect(q.limit).toBe(60);
    expect(q.month).toBe(month);
  });

  it('resets when the stored month differs', async () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo', 'budget.json'), JSON.stringify({ month: '2020-01', serpapi: { used: 50 }, anthropic: { usd: 0, calls: 0 } }));
    const { serpapi } = await freshModule();
    expect(serpapi.checkQuota().remaining).toBe(60);
  });

  it('increments the project budget on a successful search', async () => {
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch);
    await serpapi.getSerp('test keyword');
    expect(budgetOnDisk().serpapi).toEqual({ used: 1 });
  });

  it('reads account.json once per process, not once per search', async () => {
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch);
    await serpapi.getSerp('a');
    await serpapi.getSerp('b');
    expect(safeFetch.mock.calls.filter(([url]) => String(url).includes('account.json'))).toHaveLength(1);
    expect(searchCalls(safeFetch)).toHaveLength(2);
  });

  it('refunds the budget when the request fails', async () => {
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch, { search: () => Promise.reject(new Error('network down')) });
    await expect(serpapi.getSerp('kw')).rejects.toThrow('network down');
    expect(budgetOnDisk().serpapi.used).toBe(0);
  });

  it('refunds the budget on non-2xx responses', async () => {
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch, { search: () => Promise.resolve({ ok: false, status: 429 }) });
    await expect(serpapi.getSerp('kw')).rejects.toThrow('SerpAPI error: 429');
    expect(budgetOnDisk().serpapi.used).toBe(0);
  });

  it('refunds failed calls even in a parallel burst (rollback race)', async () => {
    const { serpapi, safeFetch } = await freshModule();
    // 4 parallel searches: two succeed, two fail. Net count must be exactly 2.
    let n = 0;
    route(safeFetch, { search: () => { n++; return n % 2 === 0 ? Promise.reject(new Error('boom')) : serpOk(); } });
    const results = await Promise.allSettled([
      serpapi.getSerp('a'), serpapi.getSerp('b'), serpapi.getSerp('c'), serpapi.getSerp('d'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(budgetOnDisk().serpapi.used).toBe(2);
  });

  it('hard-stops at the project limit without any request', async () => {
    seedBudget(60);
    const { serpapi, safeFetch } = await freshModule();
    await expect(serpapi.getSerp('kw')).rejects.toThrow(/monthly budget exhausted/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('hard-stops when the SerpAPI account has no searches left', async () => {
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch, { left: 0 });
    await expect(serpapi.getSerp('kw')).rejects.toThrow(/account quota exhausted/);
    expect(searchCalls(safeFetch)).toHaveLength(0);
    expect(budgetOnDisk().serpapi.used).toBe(0);
  });

  it('reports the smaller of project and account remainder', async () => {
    seedBudget(10); // project: 50 left
    const { serpapi, safeFetch } = await freshModule();
    route(safeFetch, { left: 3 });
    await serpapi.getSerp('kw'); // loads the account: 3 left, then spends one
    expect(serpapi.checkQuota().remaining).toBe(2);
  });

  it('falls back to the project budget when account.json is unreadable', async () => {
    const { serpapi, safeFetch } = await freshModule();
    safeFetch.mockImplementation((url) => (String(url).includes('account.json') ? Promise.reject(new Error('down')) : serpOk()));
    await expect(serpapi.getSerp('kw')).resolves.toBeTruthy();
  });
});
