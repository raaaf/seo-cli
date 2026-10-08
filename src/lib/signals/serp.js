// SERP adapter: pure parts (key, feature extraction, shape check). The paid
// lookup itself stays in serpapi.js (budget, account check, refund) and is
// handed in through ctx.fetchUncached, which keeps the imports acyclic.

// Stored form: booleans plus `ai_overview_hosts` (lowercase reference
// hostnames, null when the overview carries no references). Whether the
// overview cites us is not stored, it depends on the base_url of the moment
// and is worked out on read by resolveFeatures.
export const FEATURE_KEYS = ['ai_overview', 'answer_box', 'local_pack', 'shopping', 'videos'];

// Same defaults as getSerp, so a missing locale or gl hits the same entry.
export function serpKey(keyword, locale, gl) {
  const kw = String(keyword).trim().replace(/\s+/g, ' ').toLowerCase();
  return `${locale || 'de'}:${gl || 'de'}:${kw}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

const present = v => (Array.isArray(v) ? v.length > 0 : Boolean(v) && typeof v === 'object' && Object.keys(v).length > 0);

// Booleans and hostnames only; the AI Overview text and links are never kept.
// An overview that SerpAPI only announces via page_token still counts as
// present, we do not spend a second search on it.
export function extractFeatures(data) {
  const aio = data.ai_overview;
  const hasAio = Boolean(aio) && typeof aio === 'object' && !aio.error;
  const refs = hasAio && Array.isArray(aio.references) ? aio.references : [];
  const hosts = [...new Set(refs.map(r => hostOf(r?.link)).filter(Boolean))];
  return {
    ai_overview: hasAio,
    ai_overview_hosts: hosts.length > 0 ? hosts : null,
    answer_box: present(data.answer_box),
    local_pack: present(data.local_results),
    shopping: present(data.shopping_results),
    videos: present(data.inline_videos),
  };
}

// Public form for the given base_url. `ai_overview_cites_us` is true or false
// when the references and our host are known, null when there is no evidence
// (no references, no base_url); without an overview it is false. A host
// matches when it is base_url's host or a subdomain of it, never a substring.
export function resolveFeatures(stored, baseUrl) {
  const { ai_overview_hosts: hosts, ...rest } = stored;
  const baseHost = baseUrl ? hostOf(baseUrl) : null;
  let cites = false;
  if (stored.ai_overview) {
    cites = hosts && baseHost ? hosts.some(h => h === baseHost || h.endsWith(`.${baseHost}`)) : null;
  }
  return { ...rest, ai_overview_cites_us: cites };
}

const isStrings = v => Array.isArray(v) && v.every(s => typeof s === 'string');

export function isValidSerp(v) {
  return Boolean(v)
    && isStrings(v.top_titles) && isStrings(v.top_snippets)
    && isStrings(v.related_searches) && isStrings(v.people_also_ask)
    && Boolean(v.features) && FEATURE_KEYS.every(k => typeof v.features[k] === 'boolean')
    && (v.features.ai_overview_hosts === null || isStrings(v.features.ai_overview_hosts));
}

export const serpAdapter = {
  name: 'serp',
  ttlDays: 30,
  validate: isValidSerp,
  fetch: (key, ctx) => ctx.fetchUncached(),
};
