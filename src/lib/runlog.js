import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getLlmStats } from './claude.js';
import { loadBudget, budgetLimits } from './budget.js';
import { format } from './date.js';

// The last run as a file in the project (not only in the runner), plus a short
// history the weekly digest reads. Both go to main through commitState.
export const LAST_RUN_FILE = 'seo/last-run.json';
export const RUNS_LOG_FILE = 'seo/runs.jsonl';
const MAX_RUNS = 52;

// Roughly 1 percent of the weekly Max limit (see the plan's calibration).
const SUBSCRIPTION_WARN_USD = 25;

export function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

// Which backend answered, and why it did not: the fallbacks cost API money.
export function llmSummary(warnings) {
  const llm = getLlmStats();
  if (llm.fallbacks.length > 0) {
    const kinds = [...new Set(llm.fallbacks.map(f => f.kind))].join(', ');
    warnings.push(`${llm.fallbacks.length} LLM call(s) fell back from the subscription to the API (${kinds})`);
  }
  if (llm.usd_equivalent > SUBSCRIPTION_WARN_USD) {
    warnings.push(`Subscription usage this run is worth ${llm.usd_equivalent.toFixed(2)} USD on the API, over ${SUBSCRIPTION_WARN_USD} USD`);
  }
  return llm;
}

export function budgetSummary(cwd) {
  const { month, serpapi, anthropic } = loadBudget(cwd);
  const limits = budgetLimits(cwd);
  return {
    month,
    serpapi: { used: serpapi.used, limit: limits.serpapi_per_month },
    anthropic: { usd: Number(anthropic.usd.toFixed(4)), calls: anthropic.calls, limit_usd: limits.usd_per_month },
  };
}

// Existing history lines; unreadable ones are dropped with a warning, a missing file is empty.
function readRuns(path, warnings) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const runs = [];
  for (const line of lines) {
    try {
      runs.push(JSON.parse(line));
    } catch {
      warnings.push(`${RUNS_LOG_FILE} had an unreadable line, dropped`);
    }
  }
  return runs;
}

/**
 * Writes `seo/last-run.json` (the report without the per-change lists) and
 * appends one line to `seo/runs.jsonl`, kept to the last 52. Call it before the
 * final commitState. Mutates `report.warnings` when the history was damaged.
 */
export function writeRunLog({ cwd = process.cwd(), report, mode, today = format(new Date()) }) {
  const runsPath = join(cwd, RUNS_LOG_FILE);
  const runs = readRuns(runsPath, report.warnings);

  const last = { date: today, mode, ...report };
  if (report.measurement) last.measurement = { ...report.measurement, changed: undefined };
  writeReport(join(cwd, LAST_RUN_FILE), last);

  runs.push({
    date: today, mode, status: report.status, prs: report.prs, llm: report.llm, budget: report.budget,
    warnings: report.warnings.length, errors: report.errors.length,
  });
  mkdirSync(dirname(runsPath), { recursive: true });
  writeFileSync(runsPath, runs.slice(-MAX_RUNS).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
