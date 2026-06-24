import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertPublicUrl, safeFetch } from '../src/lib/safe-fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResponse(status, headersMap = {}) {
  return {
    status,
    headers: { get: (k) => headersMap[k] ?? null },
  };
}

describe('safe-fetch-assert: assertPublicUrl', () => {
  it('rejects invalid URL', async () => {
    await expect(assertPublicUrl('not-a-url')).rejects.toThrow('Invalid URL');
  });

  it('rejects ftp: protocol', async () => {
    await expect(assertPublicUrl('ftp://example.com/file')).rejects.toThrow('Disallowed protocol');
  });

  it('rejects localhost', async () => {
    await expect(assertPublicUrl('http://localhost/path')).rejects.toThrow('Disallowed host');
  });

  it('rejects 0.0.0.0', async () => {
    await expect(assertPublicUrl('http://0.0.0.0/')).rejects.toThrow('Disallowed host');
  });

  it('rejects 127.0.0.1 (loopback)', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 10.0.0.1 (private class A)', async () => {
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 169.254.169.254 (link-local / AWS metadata)', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 192.168.1.1 (private class C)', async () => {
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow(/private|internal/i);
  });
});

describe('safe-fetch-redirect: safeFetch redirect handling', () => {
  it('blocks redirect to private IP and calls fetch exactly once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(302, { location: 'http://127.0.0.1/secret' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('http://93.184.216.34/')).rejects.toThrow(/private|internal/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with Too many redirects after 5+ hops', async () => {
    // Every response redirects again (public target), so the hop cap must trigger.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(mockResponse(302, { location: `http://93.184.216.34/r${call}` }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('http://93.184.216.34/r0')).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('returns response unchanged on 200', async () => {
    const ok = mockResponse(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok));

    const res = await safeFetch('http://93.184.216.34/');
    expect(res.status).toBe(200);
  });
});
