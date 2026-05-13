import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isoWeek } from './date.js';

const QUOTA_FILE = join(process.env.HOME, '.seo-cli-serpapi.json');
const WEEKLY_LIMIT = 240; // leave 10 as buffer from the 250 free tier

function loadQuota() {
  if (!existsSync(QUOTA_FILE)) return { week: null, used: 0 };
  try { return JSON.parse(readFileSync(QUOTA_FILE, 'utf8')); } catch { return { week: null, used: 0 }; }
}

function saveQuota(q) {
  writeFileSync(QUOTA_FILE, JSON.stringify(q), 'utf8');
}

export function checkQuota() {
  const q = loadQuota();
  const week = isoWeek();
  if (q.week !== week) return { used: 0, remaining: WEEKLY_LIMIT, week };
  return { used: q.used, remaining: WEEKLY_LIMIT - q.used, week };
}

function incrementQuota() {
  const week = isoWeek();
  const q = loadQuota();
  const used = (q.week === week ? q.used : 0) + 1;
  saveQuota({ week, used });
  return used;
}

export async function getSerp(keyword, { locale = 'de', gl = 'de' } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  const { remaining } = checkQuota();
  if (remaining <= 0) throw new Error(`SerpAPI weekly quota exhausted (${WEEKLY_LIMIT} searches/week)`);

  const params = new URLSearchParams({
    q: keyword,
    hl: locale,
    gl,
    num: 10,
    api_key: process.env.SERPAPI_KEY,
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);

  incrementQuota();

  const data = await res.json();
  const results = (data.organic_results || []).slice(0, 5);

  return {
    top_titles: results.map(r => r.title),
    top_snippets: results.map(r => r.snippet).filter(Boolean),
    related_searches: (data.related_searches || []).slice(0, 5).map(r => r.query),
    people_also_ask: (data.related_questions || []).slice(0, 4).map(r => r.question),
  };
}
