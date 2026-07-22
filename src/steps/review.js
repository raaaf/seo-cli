import { readFileSync } from 'fs';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { format } from '../lib/date.js';
import { fillTemplate } from '../lib/template.js';
import { MODELS } from '../lib/models.js';
import { getExistingPages } from '../lib/landings.js';
import { defaultLocale } from '../lib/config.js';

const REVIEW_PROMPT = readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8');

// Sibling pages handed to the reviewer for cross-page number consistency. More
// than this and the prompt grows faster than the check gets better.
const CLUSTER_PAGES = 8;
const SEVERITIES = new Set(['high', 'medium', 'low']);

/**
 * Fact-check a generated page against the live web and against the already
 * published pages of the same cluster, then apply the corrections it returns.
 *
 * Returns `{ markdown, findings }`. Each finding carries `applied: boolean` —
 * a finding whose `quote` no longer matches the page (or matches ambiguously)
 * is reported but not applied, which is what the caller gates on.
 *
 * A reviewer failure is never fatal: the unreviewed page is returned with an
 * empty finding list, and the caller decides what that means.
 */
export async function reviewPage(markdown, keyword, config, cwd = process.cwd(), opts = {}) {
  const locale = opts.locale || defaultLocale(config);

  const vars = {
    markdown,
    locale,
    site_name: config.site_name || config.project || '',
    today: format(new Date()),
    cluster_context: clusterContext(config, cwd, locale),
  };

  let parsed;
  try {
    parsed = await complete({
      system: 'You are a fact-checker. You verify claims against sources and correct them. You do not rewrite prose you cannot fault.',
      prompt: fillTemplate(REVIEW_PROMPT, vars),
      model: MODELS.generate,
      maxTokens: 8000,
      json: true,
      webSearch: true,
    });
  } catch (e) {
    console.log(chalk.yellow(`  Review skipped: ${keyword.keyword} (${e.message})`));
    return { markdown, findings: [] };
  }

  const findings = (parsed?.findings || []).filter(f => f && SEVERITIES.has(f.severity) && f.quote);

  let patched = markdown;
  for (const finding of findings) {
    const occurrences = countOccurrences(patched, finding.quote);
    const replacement = typeof finding.replacement === 'string' ? finding.replacement : null;
    finding.applied = occurrences === 1 && replacement !== null && replacement !== finding.quote;
    if (finding.applied) patched = patched.replace(finding.quote, replacement);
  }

  logFindings(findings);

  return { markdown: patched, findings };
}

// Highest severity among findings that are still standing after patching.
export function unresolvedSeverity(findings) {
  return findings.some(f => !f.applied && f.severity === 'high') ? 'high' : null;
}

function logFindings(findings) {
  if (findings.length === 0) {
    console.log(chalk.green('  Fact check passed (0 findings)'));
    return;
  }
  for (const f of findings) {
    const mark = f.applied ? 'fixed' : 'NOT FIXED';
    const color = f.severity === 'high' ? chalk.red : chalk.yellow;
    console.log(color(`    [${f.severity}/${mark}] ${f.problem} — "${truncate(f.quote, 60)}"`));
  }
}

// Slug + tldr of the already published pages, which is where the cross-page
// numbers live (corridors, package prices, percentages).
function clusterContext(config, cwd, locale) {
  let pages;
  try {
    pages = getExistingPages(config, cwd, locale);
  } catch {
    return 'none';
  }
  if (!Array.isArray(pages)) return 'none';
  const lines = pages
    .filter(p => p.tldr)
    .slice(0, CLUSTER_PAGES)
    .map(p => `- ${p.slug}: ${p.tldr}`);
  return lines.length ? lines.join('\n') : 'none';
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function truncate(str, max) {
  const s = String(str).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
