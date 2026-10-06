import { format } from './date.js';
import { safeFetch } from './safe-fetch.js';
import { assertBudget, adjustSerpapi, loadBudget, budgetLimits, BudgetExceededError } from './budget.js';

// Account-wide state, read once per process from the free account.json
// endpoint (does not count against the monthly quota). Several projects share
// one SerpAPI plan, so the per-project budget alone cannot see an account that
// other projects already drained. `left` is null while unknown or unreadable.
let account = null;
let accountLoad = null;

function currentMonth() {
  return format(new Date()).slice(0, 7); // YYYY-MM
}

async function loadAccount() {
  try {
    const res = await safeFetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(process.env.SERPAPI_KEY)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.total_searches_left === 'number') {
      account = { left: data.total_searches_left, usedAtLoad: loadBudget().serpapi.used };
    }
  } catch { /* unreadable: fall back to the project budget alone */ }
}

// Smaller of the project's and the account's remaining searches. Before the
// first search of a process the account is unknown and only the project counts.
export function checkQuota() {
  const { serpapi_per_month: limit } = budgetLimits();
  const used = loadBudget().serpapi.used;
  const projectLeft = limit - used;
  const accountLeft = account ? account.left - (used - account.usedAtLoad) : Infinity;
  return { used, remaining: Math.min(projectLeft, accountLeft), limit, month: currentMonth() };
}

export async function getSerp(keyword, { locale = 'de', gl = 'de' } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  assertBudget('serpapi');
  accountLoad ??= loadAccount();
  await accountLoad;
  if (checkQuota().remaining <= 0) throw new BudgetExceededError('SerpAPI budget or account quota exhausted');
  adjustSerpapi(1);

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
    adjustSerpapi(-1);
    throw e;
  }
  if (!res.ok) {
    adjustSerpapi(-1);
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
