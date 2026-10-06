import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, CONFIG_FILE, DEFAULTS } from './config.js';
import { format } from './date.js';

export const BUDGET_FILE = 'seo/budget.json';

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

function currentMonth() {
  return format(new Date()).slice(0, 7); // YYYY-MM
}

function freshBudget() {
  return { month: currentMonth(), serpapi: { used: 0 }, anthropic: { usd: 0, calls: 0 } };
}

// Paths are relative to cwd because getSerp() and complete() know no config or
// project dir, and cwd is always the target project (see CLAUDE.md).
export function loadBudget(cwd = process.cwd()) {
  const path = join(cwd, BUDGET_FILE);
  if (!existsSync(path)) {
    const created = freshBudget();
    saveBudget(created, cwd);
    return created;
  }
  let stored;
  try { stored = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Failed to read ${BUDGET_FILE}: ${e.message}`, { cause: e }); }
  if (stored.month !== currentMonth()) return freshBudget();
  return {
    month: stored.month,
    serpapi: { used: stored.serpapi?.used ?? 0 },
    anthropic: { usd: stored.anthropic?.usd ?? 0, calls: stored.anthropic?.calls ?? 0 },
  };
}

function saveBudget(budget, cwd) {
  const path = join(cwd, BUDGET_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(budget, null, 2) + '\n', 'utf8');
}

export function budgetLimits(cwd = process.cwd()) {
  const config = existsSync(join(cwd, CONFIG_FILE)) ? loadConfig(cwd) : DEFAULTS;
  return { ...DEFAULTS.budget, ...config.budget };
}

// Throws once the month's limit is reached. Called before every paid call, so
// a call already in flight runs to the end and the next one is refused.
export function assertBudget(kind, cwd = process.cwd()) {
  const limits = budgetLimits(cwd);
  const budget = loadBudget(cwd);
  if (kind === 'serpapi') {
    if (budget.serpapi.used >= limits.serpapi_per_month) {
      throw new BudgetExceededError(`SerpAPI monthly budget exhausted (${limits.serpapi_per_month} searches/month)`);
    }
  } else if (kind === 'anthropic') {
    if (budget.anthropic.usd >= limits.usd_per_month) {
      throw new BudgetExceededError(`Anthropic monthly budget exhausted (${limits.usd_per_month} USD/month, ${budget.anthropic.usd.toFixed(2)} spent)`);
    }
  } else {
    throw new Error(`Unknown budget kind: ${kind}`);
  }
}

// Reservation (+1) and refund (-1) of one SerpAPI search. Returns the new count.
export function adjustSerpapi(delta, cwd = process.cwd()) {
  const budget = loadBudget(cwd);
  budget.serpapi.used = Math.max(0, budget.serpapi.used + delta);
  saveBudget(budget, cwd);
  return budget.serpapi.used;
}

export function addAnthropicCost(usd, cwd = process.cwd()) {
  const budget = loadBudget(cwd);
  budget.anthropic.usd += usd;
  budget.anthropic.calls += 1;
  saveBudget(budget, cwd);
}
