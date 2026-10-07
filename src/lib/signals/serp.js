// SERP adapter: pure parts (key, feature extraction, shape check). The paid
// lookup itself stays in serpapi.js (budget, account check, refund) and is
// handed in through ctx.fetchUncached, which keeps the imports acyclic.

export const FEATURE_KEYS = ['ai_overview', 'ai_overview_cites_us', 'answer_box', 'local_pack', 'shopping', 'videos'];

export function serpKey(keyword, locale = 'de', gl = 'de') {
  return `${locale}:${gl}:${String(keyword).toLowerCase()}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// Same host as base_url or a subdomain of it, never a substring match.
function isOwnHost(link, baseHost) {
  const host = hostOf(link);
  return Boolean(host && baseHost && (host === baseHost || host.endsWith(`.${baseHost}`)));
}

const present = v => (Array.isArray(v) ? v.length > 0 : Boolean(v) && typeof v === 'object' && Object.keys(v).length > 0);

// Booleans only; the AI Overview text itself is never kept. An overview that
// SerpAPI only announces via page_token still counts as present, we do not
// spend a second search on it.
export function extractFeatures(data, baseUrl) {
  const aio = data.ai_overview;
  const hasAio = Boolean(aio) && typeof aio === 'object' && !aio.error;
  const baseHost = baseUrl ? hostOf(baseUrl) : null;
  const refs = hasAio && Array.isArray(aio.references) ? aio.references : [];
  return {
    ai_overview: hasAio,
    ai_overview_cites_us: refs.some(r => isOwnHost(r?.link, baseHost)),
    answer_box: present(data.answer_box),
    local_pack: present(data.local_results),
    shopping: present(data.shopping_results),
    videos: present(data.inline_videos),
  };
}

const isStrings = v => Array.isArray(v) && v.every(s => typeof s === 'string');

export function isValidSerp(v) {
  return Boolean(v)
    && isStrings(v.top_titles) && isStrings(v.top_snippets)
    && isStrings(v.related_searches) && isStrings(v.people_also_ask)
    && Boolean(v.features) && FEATURE_KEYS.every(k => typeof v.features[k] === 'boolean');
}

export const serpAdapter = {
  name: 'serp',
  ttlDays: 30,
  validate: isValidSerp,
  fetch: (key, ctx) => ctx.fetchUncached(),
};
