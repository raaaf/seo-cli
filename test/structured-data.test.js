import { describe, it, expect } from 'vitest';
import { extractJsonLd, structuredDataFindings } from '../src/lib/structured-data.js';

const page = (...scripts) => `<html><head><title>T</title>${scripts.map(s => `<script type="application/ld+json">${s}</script>`).join('')}</head><body></body></html>`;
const find = (html, hasFaq = false, truncated = false) => structuredDataFindings({ html, hasFaq, truncated });
const faq = JSON.stringify({ '@type': 'FAQPage' });

describe('structured data findings', () => {
  it('finds FAQPage inside @graph, an array root and an @type array', () => {
    expect(find(page(JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'FAQPage' }] })), true)).toEqual([]);
    expect(find(page(JSON.stringify([{ '@type': 'FAQPage' }])), true)).toEqual([]);
    expect(find(page(JSON.stringify({ '@type': ['WebPage', 'FAQPage'] })), true)).toEqual([]);
  });

  it('reports an unparseable block', () => {
    expect(find(page('{ nope'))).toEqual(['jsonld_invalid']);
    expect(extractJsonLd(page('{ nope', faq))).toMatchObject({ invalid: 1 });
  });

  it('reports a page without JSON-LD', () => {
    expect(find('<html><head><title>T</title></head></html>')).toEqual(['jsonld_missing']);
  });

  it('reports FAQ items without a FAQPage type, and nothing for a page without FAQ', () => {
    const other = page(JSON.stringify({ '@type': 'Organization' }));
    expect(find(other, true)).toEqual(['faqpage_missing']);
    expect(find(other, false)).toEqual([]);
  });

  it('cannot judge a cut-off body or a page that is no document', () => {
    expect(find(page(faq), true, true)).toBeNull();
    expect(find('Service Unavailable')).toBeNull();
    expect(find('<html><body>maintenance</body></html>')).toBeNull();
  });
});
