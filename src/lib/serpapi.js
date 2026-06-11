import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { format } from './date.js';
import { safeFetch } from './safe-fetch.js';

const QUOTA_FILE = process.env.SEO_CLI_QUOTA_FILE || join(homedir(), '.seo-cli-serpapi.json');
// SerpAPI free tier is 250 searches per MONTH — keep 10 as buffer.
const MONTHLY_LIMIT = 240;

function currentMonth() {
  return format(new Date()).slice(0, 7); // YYYY-MM
}

let quotaCache = null;
function loadQuota() {
  if (quotaCache !== null) return quotaCache;
  if (!existsSync(QUOTA_FILE)) { quotaCache = { month: null, used: 0 }; return quotaCache; }
  try { quotaCache = JSON.parse(readFileSync(QUOTA_FILE, 'utf8')); }
  catch { quotaCache = { month: null, used: 0 }; }
  // Migrate pre-monthly files ({ week: "YYYY-Www", used }): keep the count as a
  // conservative lower bound for the current month.
  if (quotaCache.week !== undefined && quotaCache.month === undefined) {
    quotaCache = { month: currentMonth(), used: quotaCache.used ?? 0 };
  }
  return quotaCache;
}

function saveQuota(q) {
  quotaCache = q;
  writeFileSync(QUOTA_FILE, JSON.stringify(q), 'utf8');
}

export function checkQuota() {
  const q = loadQuota();
  const month = currentMonth();
  if (q.month !== month) return { used: 0, remaining: MONTHLY_LIMIT, month };
  return { used: q.used, remaining: MONTHLY_LIMIT - q.used, month };
}

function bumpQuota(currentUsed) {
  const next = currentUsed + 1;
  saveQuota({ month: currentMonth(), used: next });
  return next;
}

// Unconditional decrement: under Promise.all bursts other calls bump the
// counter between this call's bump and its failure, so an equality check
// would silently skip the refund. JS is single-threaded — each failed
// request refunds exactly its own reservation.
function rollbackQuota() {
  const q = loadQuota();
  saveQuota({ month: q.month ?? currentMonth(), used: Math.max(0, q.used - 1) });
}

export async function getSerp(keyword, { locale = 'de', gl = 'de' } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  const before = checkQuota();
  if (before.remaining <= 0) throw new Error(`SerpAPI monthly quota exhausted (${MONTHLY_LIMIT} searches/month)`);
  bumpQuota(before.used);

  const params = new URLSearchParams({
    q: keyword,
    hl: locale,
    gl,
    num: 10,
    api_key: process.env.SERPAPI_KEY,
  });

  let res;
  try {
    res = await safeFetch(`https://serpapi.com/search.json?${params}`);
  } catch (e) {
    rollbackQuota();
    throw e;
  }
  if (!res.ok) {
    rollbackQuota();
    throw new Error(`SerpAPI error: ${res.status}`);
  }

  const data = await res.json();
  const results = (data.organic_results || []).slice(0, 5);

  return {
    top_titles: results.map(r => r.title),
    top_snippets: results.map(r => r.snippet).filter(Boolean),
    related_searches: (data.related_searches || []).slice(0, 5).map(r => r.query),
    people_also_ask: (data.related_questions || []).slice(0, 4).map(r => r.question),
  };
}
