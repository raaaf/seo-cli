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

describe('safe-fetch-pinning: DNS rebinding', () => {
  it('pins the validated address: later DNS answers are never used for the connection', async () => {
    vi.resetModules();
    const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.5', family: 4 }]];
    const dnsLookup = vi.fn().mockImplementation(async () => answers.shift() ?? answers[0]);
    vi.doMock('dns/promises', () => ({ lookup: dnsLookup }));
    const mod = await import('../src/lib/safe-fetch.js');

    const resolved = await mod.assertPublicUrl('https://rebind.example/');
    const lookup = mod.pinnedLookup(resolved);
    const out = await new Promise(res => lookup('rebind.example', { all: true }, (e, list) => res(list)));
    const single = await new Promise(res => lookup('rebind.example', {}, (e, addr) => res(addr)));

    expect(out).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(single).toBe('93.184.216.34');
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    vi.doUnmock('dns/promises');
    vi.resetModules();
  });

  it('safeFetch hands fetch a pinned dispatcher on every hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(302, { location: 'http://93.184.216.35/next' }))
      .mockResolvedValueOnce(mockResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('http://93.184.216.34/');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [d1, d2] = fetchMock.mock.calls.map(c => c[1].dispatcher);
    expect(d1).toBeDefined();
    expect(d2).toBeDefined();
    expect(d1).not.toBe(d2);
  });
});

describe('safe-fetch-private: blocked address forms', () => {
  it.each([
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::]/',
    'http://169.254.10.10/',
  ])('rejects %s', async (u) => {
    await expect(assertPublicUrl(u)).rejects.toThrow(/private|internal|Disallowed/i);
  });

  it('rejects a hostname whose DNS answer is IPv4-mapped private', async () => {
    vi.resetModules();
    vi.doMock('dns/promises', () => ({ lookup: async () => [{ address: '::ffff:192.168.0.1', family: 6 }] }));
    const mod = await import('../src/lib/safe-fetch.js');
    await expect(mod.assertPublicUrl('https://evil.example/')).rejects.toThrow(/private|internal/i);
    vi.doUnmock('dns/promises');
    vi.resetModules();
  });
});
