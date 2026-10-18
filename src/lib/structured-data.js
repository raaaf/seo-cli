// JSON-LD of a live page: is there any, does it parse, does a page with FAQ items carry a FAQPage, and do the entities
// Google has rich results for carry their fields. Pure.

import { onPageFindings } from './onpage.js';

const LD_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** `{ blocks, invalid }`: the parsed JSON-LD blocks and how many failed to parse. */
export function extractJsonLd(html) {
  const blocks = [];
  let invalid = 0;
  for (const [, body] of html.matchAll(LD_SCRIPT)) {
    try {
      blocks.push(JSON.parse(body));
    } catch {
      invalid += 1;
    }
  }
  return { blocks, invalid };
}

// Every @type in a block, walking array roots and @graph.
function typesOf(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach(n => typesOf(n, found));
  else if (node && typeof node === 'object') {
    for (const t of [].concat(node['@type'] ?? [])) found.add(t);
    typesOf(node['@graph'], found);
  }
  return found;
}

/**
 * Finding codes of a fetched page (`jsonld_missing`, `jsonld_invalid`, `faqpage_missing`; [] is clean), or null when the
 * page cannot be judged: body cut off, or no `<html` and `<title` (an error or maintenance page).
 */
export function structuredDataFindings({ html, hasFaq, truncated }) {
  if (truncated || !/<html/i.test(html) || !/<title/i.test(html)) return null;
  const { blocks, invalid } = extractJsonLd(html);
  if (invalid) return ['jsonld_invalid'];
  if (!blocks.length) return ['jsonld_missing'];
  const codes = hasFaq && !blocks.some(b => typesOf(b).has('FAQPage')) ? ['faqpage_missing'] : [];
  return [...codes, ...fieldGaps(blocks).required.map(f => `required:${f}`)];
}

// Field rules per rich result type, from Google's structured data docs (developers.google.com/search/docs/appearance/
// structured-data/<type>). `required` gaps keep a page out of the rich result and open the alert as `required:<Type>.<path>`;
// `recommended` gaps are what Search Console mails as non-critical issues and only land in the report. A rule is a
// path (`location.address`), alternatives joined by `|` (one of them suffices) or a function for the nested lists.
// Fields that only apply to some sites (aggregateRating on a recipe, review on a local business) are left out.

// LocalBusiness and the subtypes a small business site is likely to use; schema.org has more, an unknown subtype is
// simply not checked.
const LOCAL_BUSINESS = new Set([
  'LocalBusiness', 'ProfessionalService', 'FoodEstablishment', 'Restaurant', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub',
  'IceCreamShop', 'FastFoodRestaurant', 'Store', 'ClothingStore', 'BookStore', 'Florist', 'HomeAndConstructionBusiness',
  'Electrician', 'Plumber', 'Locksmith', 'RoofingContractor', 'GeneralContractor', 'HVACBusiness', 'HousePainter',
  'MovingCompany', 'HealthAndBeautyBusiness', 'BeautySalon', 'HairSalon', 'NailSalon', 'DaySpa', 'HealthClub',
  'SportsActivityLocation', 'MedicalBusiness', 'Dentist', 'Physician', 'Optician', 'Pharmacy', 'LegalService',
  'Attorney', 'Notary', 'AccountingService', 'FinancialService', 'InsuranceAgency', 'AutomotiveBusiness', 'AutoRepair',
  'AutoDealer', 'LodgingBusiness', 'Hotel', 'BedAndBreakfast', 'RealEstateAgent', 'TravelAgency', 'EntertainmentBusiness',
  'ChildCare', 'EmploymentAgency', 'DryCleaningOrLaundry', 'SelfStorage', 'ShoppingCenter', 'TouristInformationCenter',
  'AnimalShelter', 'EmergencyService',
]);
const ARTICLE = new Set(['Article', 'NewsArticle', 'BlogPosting']);
const SOFTWARE = new Set(['SoftwareApplication', 'MobileApplication', 'WebApplication', 'VideoGame']);

const has = (node, path) => path.split('|').some((alt) => {
  let v = node;
  for (const key of alt.split('.')) v = Array.isArray(v) ? v[0]?.[key] : v?.[key];
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
});
const missing = (node, paths) => paths.filter(p => !has(node, p));
const list = v => [].concat(v ?? []);
const isType = (node, type) => list(node?.['@type']).includes(type);

// Recipe steps: plain strings are fine for Google, HowToStep objects are checked; a HowToSection holds its own steps.
function recipeSteps(node) {
  const steps = list(node.recipeInstructions).flatMap(s => (isType(s, 'HowToSection') ? list(s.itemListElement) : [s]));
  const objects = steps.filter(s => s && typeof s === 'object');
  const each = rules => [...new Set(objects.flatMap(s => missing(s, rules)))].map(f => `recipeInstructions.${f}`);
  return { required: each(['text|itemListElement']), recommended: each(['name', 'url', 'image|video']) };
}

function breadcrumb(node) {
  const items = list(node.itemListElement);
  if (items.length < 2) return { required: ['itemListElement'], recommended: [] };
  const gaps = items.flatMap((it, i) => [
    ...missing(it, ['position']),
    ...(has(it, 'name') || has(it, 'item.name') ? [] : ['name']),
    ...(i < items.length - 1 ? missing(it, ['item']) : []),
  ]);
  return { required: [...new Set(gaps)].map(f => `itemListElement.${f}`), recommended: [] };
}

function product(node) {
  const required = missing(node, ['name', 'offers|review|aggregateRating']);
  for (const offer of list(node.offers).filter(o => o && typeof o === 'object' && !isType(o, 'AggregateOffer'))) {
    if (!has(offer, 'price|priceSpecification.price')) required.push('offers.price');
  }
  const rating = node.aggregateRating;
  if (rating && typeof rating === 'object') required.push(...missing(rating, ['ratingValue', 'ratingCount|reviewCount']).map(f => `aggregateRating.${f}`));
  for (const review of list(node.review).filter(r => r && typeof r === 'object')) {
    required.push(...missing(review, ['author', 'reviewRating.ratingValue']).map(f => `review.${f}`));
  }
  return { required: [...new Set(required)], recommended: [] };
}

function event(node) {
  const online = list(node.location).some(l => isType(l, 'VirtualLocation'));
  return {
    required: missing(node, ['name', 'startDate', 'location', online ? 'location.url' : 'location.address']),
    recommended: missing(node, ['description', 'endDate', 'eventStatus', 'image', 'offers', 'organizer']),
  };
}

const RULES = [
  [n => isType(n, 'Recipe'), 'Recipe', (n) => {
    const steps = recipeSteps(n);
    return {
      required: [...missing(n, ['name', 'image']), ...steps.required],
      recommended: [
        ...missing(n, ['author', 'datePublished', 'description', 'keywords', 'recipeCategory', 'recipeCuisine',
          'recipeIngredient', 'recipeInstructions', 'recipeYield', 'totalTime|prepTime', 'nutrition.calories', 'video']),
        ...steps.recommended,
      ],
    };
  }],
  [n => list(n['@type']).some(t => LOCAL_BUSINESS.has(t)), 'LocalBusiness', n => ({
    required: missing(n, ['name', 'address']),
    recommended: missing(n, ['geo', 'openingHoursSpecification|openingHours', 'priceRange', 'telephone', 'url']),
  })],
  [n => isType(n, 'Product'), 'Product', product],
  [n => isType(n, 'Event') || list(n['@type']).some(t => /Event$/.test(t)), 'Event', event],
  [n => isType(n, 'BreadcrumbList'), 'BreadcrumbList', breadcrumb],
  [n => list(n['@type']).some(t => ARTICLE.has(t)), 'Article', n => ({
    required: [],
    recommended: missing(n, ['author', 'datePublished', 'dateModified', 'headline', 'image']),
  })],
  [n => isType(n, 'VideoObject'), 'VideoObject', n => ({
    required: missing(n, ['name', 'thumbnailUrl', 'uploadDate']),
    recommended: missing(n, ['description', 'contentUrl|embedUrl', 'duration']),
  })],
  [n => list(n['@type']).some(t => SOFTWARE.has(t)), 'SoftwareApplication', n => ({
    required: missing(n, ['name', 'offers.price', 'aggregateRating|review']),
    recommended: missing(n, ['applicationCategory', 'operatingSystem']),
  })],
  [n => isType(n, 'ProfilePage'), 'ProfilePage', n => ({
    required: missing(n, ['mainEntity', 'mainEntity.name|mainEntity.alternateName']).slice(0, 1),
    recommended: missing(n, ['dateCreated', 'dateModified', 'mainEntity.description', 'mainEntity.image', 'mainEntity.sameAs']),
  })],
  [n => isType(n, 'WebSite'), 'WebSite', n => ({ required: missing(n, ['name', 'url']), recommended: [] })],
  // No rich result of its own, but the entity search engines and AI answers tie the site to: name, logo and the
  // profiles in sameAs are what make it recognisable.
  [n => isType(n, 'Organization'), 'Organization', n => ({
    required: [],
    recommended: missing(n, ['name', 'url', 'logo', 'sameAs', 'description']),
  })],
];

// Top-level entities of the blocks: array roots and @graph members.
function entities(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => entities(n, out));
  else if (node && typeof node === 'object') {
    if (node['@type']) out.push(node);
    entities(node['@graph'], out);
  }
  return out;
}

/** `{ required, recommended }`: missing fields as `<Type>.<path>`, deduplicated, over all checked entities of the blocks. */
export function fieldGaps(blocks) {
  const required = new Set();
  const recommended = new Set();
  for (const node of entities(blocks)) {
    for (const [match, label, check] of RULES) {
      if (!match(node)) continue;
      const gaps = check(node);
      gaps.required.forEach(f => required.add(`${label}.${f}`));
      gaps.recommended.forEach(f => recommended.add(`${label}.${f}`));
    }
  }
  return { required: [...required].sort(), recommended: [...recommended].sort() };
}

/** Recommended gaps of a fetched page (see fieldGaps), [] when the page has none or cannot be read. */
export function recommendedGaps(html) {
  return fieldGaps(extractJsonLd(html).blocks).recommended;
}

/**
 * The whole page check of the watcher: JSON-LD findings (see structuredDataFindings) plus the on-page signals of
 * onPageFindings, `{ codes, recommended }`, or null when the page cannot be judged.
 */
export function pageCheck({ html, headers, url, hasFaq, truncated }) {
  const codes = structuredDataFindings({ html, hasFaq, truncated });
  if (codes === null) return null;
  const { blocks } = extractJsonLd(html);
  const onPage = onPageFindings({ html, headers, url, types: typesOf(blocks) });
  return { codes: [...codes, ...onPage.codes], recommended: [...fieldGaps(blocks).recommended, ...onPage.recommended] };
}
