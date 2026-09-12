import { describe, it, expect, vi } from 'vitest';
import { extractSitemapUrls, submitIndexNow } from '../src/lib/indexnow.js';

describe('extractSitemapUrls', () => {
  it('extracts all <loc> values from sitemap XML', () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://acme.io/a</loc></url>
  <url><loc>https://acme.io/b</loc></url>
  <url><loc>https://acme.io/c</loc></url>
</urlset>`;
    expect(extractSitemapUrls(xml)).toEqual([
      'https://acme.io/a',
      'https://acme.io/b',
      'https://acme.io/c',
    ]);
  });
});

describe('submitIndexNow', () => {
  it('builds the right body and returns ok for 202', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202, text: async () => '' });
    const result = await submitIndexNow({
      baseUrl: 'https://acme.io',
      key: 'abc123',
      urls: ['https://acme.io/a', 'https://acme.io/b'],
      fetchImpl,
    });

    expect(result).toEqual({ status: 202, ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.indexnow.org/indexnow',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      host: 'acme.io',
      key: 'abc123',
      keyLocation: 'https://acme.io/abc123.txt',
      urlList: ['https://acme.io/a', 'https://acme.io/b'],
    });
  });

  it('returns ok for 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, text: async () => '' });
    const result = await submitIndexNow({
      baseUrl: 'https://acme.io',
      key: 'abc123',
      urls: ['https://acme.io/a'],
      fetchImpl,
    });
    expect(result).toEqual({ status: 200, ok: true });
  });

  it('throws with the status and response text on other statuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 422, text: async () => 'Invalid key' });
    await expect(
      submitIndexNow({ baseUrl: 'https://acme.io', key: 'abc123', urls: ['https://acme.io/a'], fetchImpl })
    ).rejects.toThrow(/422/);
  });
});
