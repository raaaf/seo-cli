import { describe, it, expect } from 'vitest';
import { extractJsonLd, fieldGaps, pageCheck, recommendedGaps, structuredDataFindings } from '../src/lib/structured-data.js';
import { onPageFindings } from '../src/lib/onpage.js';

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

  it('reports FAQ items without a FAQPage type as recommended only, and nothing for a page without FAQ', () => {
    const other = page(JSON.stringify({ '@type': 'Organization' }));
    expect(find(other, true)).toEqual([]);
    const check = hasFaq => pageCheck({ html: other, url: 'https://a.de/p', hasFaq, truncated: false });
    expect(check(true)).toMatchObject({ codes: [], recommended: expect.arrayContaining(['FAQPage']) });
    expect(check(false).recommended).not.toContain('FAQPage');
  });

  it('cannot judge a cut-off body or a page that is no document', () => {
    expect(find(page(faq), true, true)).toBeNull();
    expect(find('Service Unavailable')).toBeNull();
    expect(find('<html><body>maintenance</body></html>')).toBeNull();
  });
});

describe('field gaps per rich result type', () => {
  const gaps = (...nodes) => fieldGaps(nodes);

  it('recipe: name and image required, the Search Console step issues recommended', () => {
    const recipe = { '@type': 'Recipe', name: 'R', recipeInstructions: [{ '@type': 'HowToStep', text: 'a' }, 'plain step'] };
    const { required, recommended } = gaps(recipe);
    expect(required).toEqual(['Recipe.image']);
    expect(recommended).toEqual(expect.arrayContaining([
      'Recipe.recipeCategory', 'Recipe.video', 'Recipe.recipeInstructions.name', 'Recipe.recipeInstructions.url', 'Recipe.recipeInstructions.image|video',
    ]));
    expect(gaps({ ...recipe, recipeInstructions: [{ '@type': 'HowToStep' }] }).required).toContain('Recipe.recipeInstructions.text|itemListElement');
    const section = { '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'a', name: 'n', url: 'u', image: 'i' }] };
    expect(gaps({ ...recipe, image: 'i', recipeInstructions: [section] }).recommended.filter(f => f.includes('recipeInstructions.'))).toEqual([]);
  });

  it('local business: subtypes count, name and address required, a type array works', () => {
    expect(gaps({ '@type': 'Restaurant', name: 'X' }).required).toEqual(['LocalBusiness.address']);
    expect(gaps({ '@type': ['Place', 'ProfessionalService'], name: 'X', address: { '@type': 'PostalAddress' }, telephone: '1' }))
      .toEqual({ required: [], recommended: ['LocalBusiness.geo', 'LocalBusiness.openingHoursSpecification|openingHours', 'LocalBusiness.priceRange', 'LocalBusiness.url'] });
    expect(gaps({ '@type': 'Organization', name: 'O', url: 'u', logo: 'l', description: 'd' })).toEqual({ required: [], recommended: ['Organization.sameAs'] });
  });

  it('product: offers, review or rating, and their own required fields', () => {
    expect(gaps({ '@type': 'Product', name: 'P' }).required).toEqual(['Product.offers|review|aggregateRating']);
    expect(gaps({ '@type': 'Product', name: 'P', offers: { '@type': 'Offer' } }).required).toEqual(['Product.offers.price']);
    expect(gaps({ '@type': 'Product', name: 'P', offers: { '@type': 'Offer', priceSpecification: { price: 1 } } }).required).toEqual([]);
    expect(gaps({ '@type': 'Product', name: 'P', aggregateRating: { ratingValue: 4 } }).required).toEqual(['Product.aggregateRating.ratingCount|reviewCount']);
  });

  it('event: location address, or its url for an online event', () => {
    expect(gaps({ '@type': 'MusicEvent', name: 'E', startDate: '2026-11-01', location: { '@type': 'Place' } }).required).toEqual(['Event.location.address']);
    expect(gaps({ '@type': 'Event', name: 'E', startDate: 'd', location: { '@type': 'VirtualLocation', url: 'u' } }).required).toEqual([]);
  });

  it('breadcrumb: two items, position and name each, item on all but the last', () => {
    expect(gaps({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, name: 'A', item: 'u' }] }).required).toEqual(['BreadcrumbList.itemListElement']);
    expect(gaps({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, name: 'A' }, { position: 2, name: 'B' }] }).required).toEqual(['BreadcrumbList.itemListElement.item']);
    expect(gaps({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, item: { '@id': 'u', name: 'A' } }, { position: 2, name: 'B' }] }).required).toEqual([]);
  });

  it('article has nothing required, only recommended fields', () => {
    expect(gaps({ '@type': 'BlogPosting', headline: 'H' })).toEqual({ required: [], recommended: ['Article.author', 'Article.dateModified', 'Article.datePublished', 'Article.image'] });
  });

  it('turns required gaps into findings and finds entities inside @graph', () => {
    expect(find(page(JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Recipe', image: 'i' }] })))).toEqual(['required:Recipe.name']);
    expect(recommendedGaps(page(JSON.stringify({ '@type': 'Recipe', name: 'R', image: 'i' })))).toContain('Recipe.recipeCategory');
    expect(recommendedGaps('{ nope')).toEqual([]);
  });
});

describe('more types', () => {
  it('video, software app, profile page and website', () => {
    expect(fieldGaps([{ '@type': 'VideoObject', name: 'V' }]).required).toEqual(['VideoObject.thumbnailUrl', 'VideoObject.uploadDate']);
    expect(fieldGaps([{ '@type': 'MobileApplication', name: 'A', offers: { price: 0 } }]).required).toEqual(['SoftwareApplication.aggregateRating|review']);
    expect(fieldGaps([{ '@type': 'ProfilePage', mainEntity: { '@type': 'Person' } }]).required).toEqual(['ProfilePage.mainEntity.name|mainEntity.alternateName']);
    expect(fieldGaps([{ '@type': 'ProfilePage' }]).required).toEqual(['ProfilePage.mainEntity']);
    expect(fieldGaps([{ '@type': 'WebSite', name: 'S' }]).required).toEqual(['WebSite.url']);
  });
});

describe('on-page signals', () => {
  const URL_ = 'https://a.de/page';
  const doc = (head, body = '<h1>H</h1>', lang = ' lang="de"') => `<html${lang}><head><title>T</title>${head}</head><body>${body}</body></html>`;
  const full = '<meta name="description" content="D"><link rel="canonical" href="https://a.de/page/"><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="i">';

  it('a complete page has nothing to say', () => {
    expect(onPageFindings({ html: doc(full), url: URL_ })).toEqual({ codes: [], recommended: [] });
  });

  it('noindex from the meta tag or the header, a canonical to another URL', () => {
    expect(onPageFindings({ html: doc(`${full}<meta name="robots" content="noindex, follow">`), url: URL_ }).codes).toEqual(['meta_noindex']);
    expect(onPageFindings({ html: doc(full), headers: { 'x-robots-tag': 'noindex' }, url: URL_ }).codes).toEqual(['meta_noindex']);
    const other = full.replace('https://a.de/page/', '/other');
    expect(onPageFindings({ html: doc(other), url: URL_ }).codes).toEqual(['canonical_other']);
    expect(onPageFindings({ html: doc(full.replace('https://a.de', 'https://www.A.de')), url: URL_ }).codes).toEqual([]);
  });

  it('recommends the missing signals, and WebSite plus an entity on the home page', () => {
    expect(onPageFindings({ html: doc('', '<h1>a</h1><h1>b</h1>', ''), url: URL_ }).recommended)
      .toEqual(['meta_description', 'canonical', 'html_lang', 'og:title', 'og:description', 'og:image', 'h1_multiple']);
    expect(onPageFindings({ html: doc(full.replace('/page/', '/')), url: 'https://a.de/' }).recommended).toEqual(['WebSite', 'Organization|Person']);
    expect(onPageFindings({ html: doc(full.replace('/page/', '/')), url: 'https://a.de/', types: new Set(['WebSite', 'Restaurant']) }).recommended).toEqual([]);
  });

  it('pageCheck joins JSON-LD and on-page findings', () => {
    const html = doc(`${full}<meta name="robots" content="noindex"><script type="application/ld+json">{"@type":"Recipe","name":"R"}</script>`);
    const result = pageCheck({ html, url: URL_, hasFaq: false, truncated: false });
    expect(result.codes).toEqual(['required:Recipe.image', 'meta_noindex']);
    expect(result.recommended).toContain('Recipe.recipeCategory');
    expect(pageCheck({ html: 'down', url: URL_ })).toBeNull();
  });
});
