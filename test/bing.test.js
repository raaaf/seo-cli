import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const KEY = 'SECRETKEY123';

async function freshModule() {
  vi.resetModules();
  const { safeFetch } = await import('../src/lib/safe-fetch.js');
  const bing = await import('../src/lib/bing.js');
  return { bing, safeFetch };
}

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected bingRequest to throw');
}

beforeEach(() => {
  process.env.BING_WEBMASTER_KEY = KEY;
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.BING_WEBMASTER_KEY;
});

describe('parseBingDate', () => {
  it('returns the UTC date of the epoch milliseconds', async () => {
    const { bing } = await freshModule();
    expect(bing.parseBingDate('/Date(1776384000000)/')).toBe('2026-04-17');
  });

  it('returns null for the never-crawled value (year 0001)', async () => {
    const { bing } = await freshModule();
    expect(bing.parseBingDate('/Date(-62135596800000)/')).toBeNull();
  });

  it('returns null before year 2000 and keeps 2000-01-01 itself', async () => {
    const { bing } = await freshModule();
    expect(bing.parseBingDate('/Date(946684799999)/')).toBeNull();
    expect(bing.parseBingDate('/Date(946684800000)/')).toBe('2000-01-01');
  });

  it('returns null for malformed or empty input', async () => {
    const { bing } = await freshModule();
    for (const bad of ['', 'garbage', '/Date()/', '/Date(abc)/', null, undefined]) {
      expect(bing.parseBingDate(bad)).toBeNull();
    }
  });
});

describe('siteUrl', () => {
  it('prefers bing.site_url over base_url', async () => {
    const { bing } = await freshModule();
    expect(bing.siteUrl({ base_url: 'https://x.de', bing: { site_url: 'https://www.x.de/' } })).toBe('https://www.x.de/');
  });

  it('gives base_url exactly one trailing slash', async () => {
    const { bing } = await freshModule();
    expect(bing.siteUrl({ base_url: 'https://x.de' })).toBe('https://x.de/');
    expect(bing.siteUrl({ base_url: 'https://x.de/' })).toBe('https://x.de/');
  });
});

describe('bingRequest', () => {
  it('GETs the method URL with params and apikey and returns the d field', async () => {
    const { bing, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(res(200, { d: [{ Query: 'a' }] }));
    const out = await bing.bingRequest('GetQueryStats', { siteUrl: 'https://x.de/' });
    expect(out).toEqual([{ Query: 'a' }]);
    const url = new URL(String(safeFetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats');
    expect(url.searchParams.get('siteUrl')).toBe('https://x.de/');
    expect(url.searchParams.get('apikey')).toBe(KEY);
  });

  it('maps the 400 InvalidApiKey body to key_rejected', async () => {
    const { bing, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(res(400, '{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}'));
    const err = await failure(bing.bingRequest('GetQueryStats'));
    expect(err).toBeInstanceOf(bing.BingError);
    expect(err.kind).toBe('key_rejected');
    expect(err.method).toBe('GetQueryStats');
    expect(err.status).toBe(400);
  });

  it.each([
    [401, 'key_rejected'],
    [403, 'key_rejected'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { bing, safeFetch } = await freshModule();
    safeFetch.mockResolvedValue(res(status, { Message: 'x' }));
    const err = await failure(bing.bingRequest('GetQueryStats'));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('never leaks the key when Bing echoes the URL in the body', async () => {
    const { bing, safeFetch } = await freshModule();
    const echoed = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=${KEY}`;
    for (const status of [400, 401, 429, 500]) {
      safeFetch.mockResolvedValue(res(status, { ErrorCode: 3, Message: `InvalidApiKey for ${echoed}` }));
      const err = await failure(bing.bingRequest('GetQueryStats'));
      expect(err.message).not.toContain(KEY);
      expect(String(err)).not.toContain(KEY);
    }
  });

  it('never leaks the key when safeFetch throws with the URL in its message', async () => {
    const { bing, safeFetch } = await freshModule();
    const url = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=${KEY}`;
    for (const msg of [`Too many redirects (max 5) from ${url}`, `Invalid URL: ${url}`]) {
      safeFetch.mockRejectedValue(new Error(msg));
      const err = await failure(bing.bingRequest('GetQueryStats'));
      expect(err).toBeInstanceOf(bing.BingError);
      expect(['unavailable', 'error']).toContain(err.kind);
      expect(err.message).not.toContain(KEY);
      expect(String(err)).not.toContain(KEY);
    }
  });

  it('maps a timeout to unavailable', async () => {
    const { bing, safeFetch } = await freshModule();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    safeFetch.mockRejectedValue(abort);
    const err = await failure(bing.bingRequest('GetQueryStats'));
    expect(err.kind).toBe('unavailable');
    expect(String(err)).not.toContain(KEY);
  });
});
