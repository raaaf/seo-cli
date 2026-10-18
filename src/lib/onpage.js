// On-page signals of a fetched page that search engines and AI answers read besides JSON-LD. Pure.
//
// `codes` contradict the page being in the sitemap and open the structured_data alert: a robots noindex (meta tag or
// X-Robots-Tag header) or a canonical that names another URL. `recommended` only lands in the report: a missing
// meta description, canonical, `<html lang>`, Open Graph title/description/image, a missing or doubled `<h1>`, and on
// the home page a WebSite entity (Google reads the site name from it) and an Organization or Person entity.

const TAG = (name) => new RegExp(`<${name}\\b([^>]*)>`, 'gi');
const ATTR = /([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrs(raw) {
  const out = {};
  for (const m of raw.matchAll(ATTR)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

const tags = (html, name) => [...html.matchAll(TAG(name))].map(m => attrs(m[1]));
const meta = (html, key, value) => tags(html, 'meta').filter(a => (a[key] ?? '').toLowerCase() === value).map(a => a.content ?? '');
const filled = values => values.some(v => v.trim());

// Host lowercased, `www.` and a trailing slash ignored, query kept: what has to match for a canonical to name itself.
// An unparseable href counts as the same URL, it decides nothing.
function sameUrl(href, url) {
  try {
    const norm = (u) => {
      const x = new URL(u, url);
      return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    };
    return norm(href) === norm(url);
  } catch {
    return true;
  }
}

/** `{ codes, recommended }` for a page fetched from `url`; `headers` has lowercase keys, `types` are its JSON-LD @types. */
export function onPageFindings({ html, headers = {}, url, types = new Set() }) {
  const codes = [];
  const robots = [...meta(html, 'name', 'robots'), ...meta(html, 'name', 'googlebot'), headers['x-robots-tag'] ?? ''];
  if (robots.some(v => /\b(noindex|none)\b/i.test(v))) codes.push('meta_noindex');
  const canonical = tags(html, 'link').find(a => (a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))?.href;
  if (canonical && !sameUrl(canonical, url)) codes.push('canonical_other');

  const recommended = [];
  if (!filled(meta(html, 'name', 'description'))) recommended.push('meta_description');
  if (!canonical) recommended.push('canonical');
  if (!tags(html, 'html')[0]?.lang) recommended.push('html_lang');
  for (const og of ['og:title', 'og:description', 'og:image']) if (!filled(meta(html, 'property', og))) recommended.push(og);
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  if (h1 !== 1) recommended.push(h1 ? 'h1_multiple' : 'h1');
  if (new URL(url).pathname.replace(/\/+$/, '') === '') {
    if (!types.has('WebSite')) recommended.push('WebSite');
    if (!types.has('Organization') && !types.has('Person') && ![...types].some(t => /Business|Store|Restaurant|Service$/.test(t))) recommended.push('Organization|Person');
  }
  return { codes, recommended };
}
