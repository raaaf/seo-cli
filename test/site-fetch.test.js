import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/lib/safe-fetch.js');
const { stripHtml, fetchPages } = await import('../src/lib/site-fetch.js');

describe('sitefetch-strip: stripHtml', () => {
  it('removes script/style/comments and tags, decodes entities, collapses whitespace', () => {
    const html = `
      <style>.a{color:red}</style>
      <script>alert(1)</script>
      <!-- note -->
      <h1>Title</h1>
      <p>Caf&eacute; &amp; tea &lt;b&gt;</p>`;
    const text = stripHtml(html);
    expect(text).not.toMatch(/alert|color:red|note/);
    expect(text).toContain('Title');
    expect(text).toContain('& tea <b>');
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('handles null input', () => {
    expect(stripHtml(null)).toBe('');
  });
});

describe('sitefetch-pages: fetchPages', () => {
  beforeEach(() => safeFetch.mockReset());

  it('returns only ok responses with stripped text, dropping failures', async () => {
    safeFetch.mockImplementation(async (url) => {
      if (url && url.includes('bad')) throw new Error('network');
      if (url && url.includes('404')) return { ok: false };
      return { ok: true, text: async () => '<p>Hello <b>World</b></p>' };
    });
    const out = await fetchPages(['https://x.test/good', 'https://x.test/bad', 'https://x.test/404']);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://x.test/good');
    expect(out[0].text).toBe('Hello World');
  });

  it('truncates oversize bodies before stripping', async () => {
    const big = '<p>' + 'a'.repeat(500) + '</p>';
    safeFetch.mockResolvedValue({ ok: true, text: async () => big });
    const out = await fetchPages(['https://x.test/big'], { maxBytes: 50 });
    expect(out[0].html.length).toBe(50);
  });
});
