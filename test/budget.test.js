import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { assertBudget, addAnthropicCost, addSubscriptionUsage, adjustSerpapi, loadBudget, BudgetExceededError, BUDGET_FILE } from '../src/lib/budget.js';

const month = new Date().toISOString().slice(0, 7);
let dir;
function seed(budget) {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, BUDGET_FILE), typeof budget === 'string' ? budget : JSON.stringify(budget));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-budget-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('budget', () => {
  it('creates a missing file with zeroed counters', () => {
    expect(loadBudget(dir)).toEqual({ month, serpapi: { used: 0 }, anthropic: { usd: 0, calls: 0 }, subscription: { calls: 0, usd_equivalent: 0 } });
    expect(existsSync(join(dir, BUDGET_FILE))).toBe(true);
  });

  it('resets the counters when the stored month differs', () => {
    seed({ month: '2020-01', serpapi: { used: 59 }, anthropic: { usd: 29, calls: 10 } });
    expect(loadBudget(dir).serpapi.used).toBe(0);
    expect(() => assertBudget('serpapi', dir)).not.toThrow();
    expect(() => assertBudget('anthropic', dir)).not.toThrow();
  });

  it('refuses a SerpAPI search once the default limit of 60 is reached', () => {
    seed({ month, serpapi: { used: 59 }, anthropic: { usd: 0, calls: 0 } });
    expect(() => assertBudget('serpapi', dir)).not.toThrow();
    adjustSerpapi(1, dir);
    expect(() => assertBudget('serpapi', dir)).toThrow(BudgetExceededError);
  });

  it('refuses an Anthropic call once the limit is reached, taking the limit from seo.config.yaml', () => {
    writeFileSync(join(dir, 'seo.config.yaml'), 'budget:\n  usd_per_month: 5\n');
    addAnthropicCost(4.99, dir);
    expect(() => assertBudget('anthropic', dir)).not.toThrow();
    addAnthropicCost(0.01, dir);
    expect(() => assertBudget('anthropic', dir)).toThrow(BudgetExceededError);
    expect(JSON.parse(readFileSync(join(dir, BUDGET_FILE), 'utf8')).anthropic.calls).toBe(2);
  });

  it('books subscription calls separately and never refuses them against the API limit', () => {
    writeFileSync(join(dir, 'seo.config.yaml'), 'budget:\n  usd_per_month: 1\n');
    addSubscriptionUsage(30, dir);
    addSubscriptionUsage(0.5, dir);
    expect(() => assertBudget('anthropic', dir)).not.toThrow();
    const stored = JSON.parse(readFileSync(join(dir, BUDGET_FILE), 'utf8'));
    expect(stored.subscription).toEqual({ calls: 2, usd_equivalent: 30.5 });
    expect(stored.anthropic).toEqual({ usd: 0, calls: 0 });
    expect(loadBudget(dir).subscription).toEqual({ calls: 2, usd_equivalent: 30.5 });
  });

  it('normalises a stored file without a subscription section', () => {
    seed({ month, serpapi: { used: 1 }, anthropic: { usd: 2, calls: 3 } });
    expect(loadBudget(dir).subscription).toEqual({ calls: 0, usd_equivalent: 0 });
  });

  it('throws on an unreadable file instead of resetting it', () => {
    seed('{ not json');
    expect(() => loadBudget(dir)).toThrow(/Failed to read seo\/budget\.json/);
  });

  it('never drops the SerpAPI counter below zero on a refund', () => {
    expect(adjustSerpapi(-1, dir)).toBe(0);
  });
});
