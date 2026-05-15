import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isoWeek } from './date.js';
import { safeFetch } from './safe-fetch.js';

const QUOTA_FILE = join(homedir(), '.seo-cli-serpapi.json');
const WEEKLY_LIMIT = 240; // leave 10 as buffer from the 250 free tier

let quotaCache = null;
function loadQuota() {
  if (quotaCache !== null) return quotaCache;
  if (!existsSync(QUOTA_FILE)) { quotaCache = { week: null, used: 0 }; return quotaCache; }
  try { quotaCache = JSON.parse(readFileSync(QUOTA_FILE, 'utf8')); }
  catch { quotaCache = { week: null, used: 0 }; }
  return quotaCache;
}

function saveQuota(q) {
  quotaCache = q;
  writeFileSync(QUOTA_FILE, JSON.stringify(q), 'utf8');
}

export function checkQuota() {
  const q = loadQuota();
  const week = isoWeek();
  if (q.week !== week) return { used: 0, remaining: WEEKLY_LIMIT, week };
  return { used: q.used, remaining: WEEKLY_LIMIT - q.used, week };
}

function bumpQuota(currentUsed) {
  const week = isoWeek();
  const next = currentUsed + 1;
  saveQuota({ week, used: next });
  return next;
}

function rollbackQuota(reservedUsed) {
  const q = loadQuota();
  if (q.used === reservedUsed) {
    saveQuota({ week: q.week, used: reservedUsed - 1 });
  }
}

export async function getSerp(keyword, { locale = 'de', gl = 'de' } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  const before = checkQuota();
  if (before.remaining <= 0) throw new Error(`SerpAPI weekly quota exhausted (${WEEKLY_LIMIT} searches/week)`);
  const reservedUsed = bumpQuota(before.used);

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
    rollbackQuota(reservedUsed);
    throw e;
  }
  if (!res.ok) {
    rollbackQuota(reservedUsed);
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
