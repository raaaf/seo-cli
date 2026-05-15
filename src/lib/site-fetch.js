import { safeFetch } from './safe-fetch.js';

/**
 * Strip HTML to plain text. Removes scripts, styles, and HTML tags; collapses whitespace.
 */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch a list of absolute URLs in parallel and return successful ones with stripped text.
 * Failures (network errors, non-2xx, oversize bodies) are filtered out silently.
 *
 * @param {string[]} urls - absolute URLs to fetch
 * @param {object} [options]
 * @param {number} [options.maxBytes=200000] - per-response cap; longer bodies are truncated before stripping
 * @returns {Promise<Array<{ url: string, html: string, text: string }>>}
 */
export async function fetchPages(urls, { maxBytes = 200000 } = {}) {
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const res = await safeFetch(url);
      if (!res.ok) return null;
      const raw = await res.text();
      const html = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      return { url, html, text: stripHtml(html) };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}
