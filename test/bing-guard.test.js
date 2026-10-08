import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/lib/safe-fetch.js');
const bing = await import('../src/lib/bing.js');

const res = (status, body = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const fails = (p) => p.then(() => null, e => e);

beforeEach(() => {
  process.env.BING_WEBMASTER_KEY = 'k';
  bing.resetBingGuard();
  safeFetch.mockReset();
});
afterEach(() => { delete process.env.BING_WEBMASTER_KEY; });

describe('bingRequest failure guard', () => {
  it('stops calling Bing after two failures in a row', async () => {
    safeFetch.mockResolvedValue(res(500));
    await fails(bing.bingRequest('A'));
    await fails(bing.bingRequest('B'));
    const err = await fails(bing.bingRequest('C'));
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(bing.BingError);
    expect(err.kind).toBe('unavailable');
  });

  it('a success resets the count', async () => {
    safeFetch.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200, { d: 1 })).mockResolvedValue(res(500));
    await fails(bing.bingRequest('A'));
    expect(await bing.bingRequest('B')).toBe(1);
    await fails(bing.bingRequest('C'));
    await bing.bingRequest('D').catch(() => {});
    expect(safeFetch).toHaveBeenCalledTimes(4);
  });

  it('a rejected key stops the very next call', async () => {
    safeFetch.mockResolvedValue(res(401));
    await fails(bing.bingRequest('A'));
    const err = await fails(bing.bingRequest('B'));
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe('key_rejected');
  });
});

describe('isCrawled', () => {
  it('needs a real LastCrawledDate, HttpStatus 0 alone is no error', () => {
    expect(bing.isCrawled({ LastCrawledDate: '/Date(1776384000000)/', HttpStatus: 0 })).toBe(true);
    expect(bing.isCrawled({ LastCrawledDate: '/Date(-62135596800000)/', HttpStatus: 0 })).toBe(false);
    expect(bing.isCrawled(null)).toBe(false);
  });

  it('reads ErrorCode 5 (ThrottleHost) as rate_limited, not as a plain error', async () => {
    safeFetch.mockResolvedValueOnce(res(400, { ErrorCode: 5, Message: 'ERROR!!! ThrottleHost' }));
    const err = await fails(bing.bingRequest('GetUrlInfo'));
    expect(err.kind).toBe('rate_limited');
  });
});
