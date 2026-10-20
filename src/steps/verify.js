import { readFileSync } from 'fs';
import chalk from 'chalk';
import { assertBudget } from '../lib/budget.js';
import { format } from '../lib/date.js';
import { fillTemplate } from '../lib/template.js';
import { defaultLocale } from '../lib/config.js';
import { runJsonCheck, parseFindings, applyFindings, productFactsBlock } from './review.js';

const VERIFY_PROMPT = readFileSync(new URL('../prompts/verify.md', import.meta.url), 'utf8');

// A verify round that patched something is checked once more; after the second round
// whatever stands is the verdict.
const MAX_ROUNDS = 2;
const SECTION_START = '<!-- seo-verify:start -->';
const SECTION_END = '<!-- seo-verify:end -->';

// A law claim the model reports without the statute wording it relied on is unconfirmed.
function unquotedStatuteFindings(parsed) {
  const checks = Array.isArray(parsed?.statute_checks) ? parsed.statute_checks : [];
  return checks
    .filter(c => c && typeof c.claim === 'string' && c.claim && !(typeof c.statute_quote === 'string' && c.statute_quote.trim()))
    .map(c => ({
      severity: 'high',
      category: 'law',
      quote: c.claim,
      problem: 'Law claim without a quoted statute text, not confirmed against the official source.',
      source: c.source ?? '',
      applied: false,
    }));
}

async function verifyRound(markdown, config, cwd, locale) {
  assertBudget('anthropic', cwd);
  const prompt = fillTemplate(VERIFY_PROMPT, {
    markdown,
    locale,
    site_name: config.site_name || config.project || '',
    today: format(new Date()),
    product_facts: productFactsBlock(config, cwd),
  });
  const parsed = await runJsonCheck({
    system: 'You are an independent fact verifier. You recompute numbers and confirm claims against primary sources. You do not rewrite prose you cannot fault.',
    prompt,
  });
  const findings = parseFindings(parsed);
  const patched = applyFindings(markdown, findings, { allowMulti: true });
  return { patched, findings: [...findings, ...unquotedStatuteFindings(parsed)] };
}

/**
 * Independent second fact pass on a page, up to MAX_ROUNDS. Returns the patched
 * markdown and every finding with `applied` and the `round` it came from;
 * `blocked` is true while any finding is unpatched. Throws when the model
 * cannot be reached or answers twice without JSON (the caller blocks on that).
 */
export async function verifyPage(markdown, config, cwd = process.cwd(), opts = {}) {
  const locale = opts.locale || defaultLocale(config);
  let current = markdown;
  const all = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { patched, findings } = await verifyRound(current, config, cwd, locale);
    all.push(...findings.map(f => ({ ...f, round })));
    current = patched;
    if (!findings.some(f => f.applied)) break;
  }
  for (const f of all) {
    const color = f.applied ? chalk.yellow : chalk.red;
    console.log(color(`    [${f.applied ? 'patched' : 'BLOCKING'}/${f.category ?? 'other'}] ${f.problem}`));
  }
  return { markdown: current, findings: all, blocked: all.some(f => !f.applied) };
}

/** The PR-body section for the verified pages, between the markers. */
export function renderVerifySection(pages) {
  const lines = [SECTION_START, '### seo verify', ''];
  const withFindings = pages.filter(p => p.findings.length > 0);
  if (withFindings.length === 0) lines.push('No findings.');
  for (const page of withFindings) {
    lines.push(`**${page.file}**`);
    for (const f of page.findings) {
      lines.push(`- ${f.applied ? 'patched' : 'BLOCKING'} (${f.category ?? 'other'}): ${f.problem}${f.source ? ` (${f.source})` : ''}`);
    }
  }
  lines.push(SECTION_END);
  return lines.join('\n');
}

/** `body` with its seo-verify section replaced, or the section appended when the body has none. */
export function replaceVerifySection(body, section) {
  const text = String(body ?? '');
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start !== -1 && end > start) return text.slice(0, start) + section + text.slice(end + SECTION_END.length);
  return `${text.trimEnd()}\n\n${section}\n`;
}
