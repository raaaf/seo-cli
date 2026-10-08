import { readFileSync } from 'fs';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { rethrowIfBudget } from '../lib/budget.js';
import { defaultLocale } from '../lib/config.js';
import { format } from '../lib/date.js';
import { addDays } from '../lib/measure.js';
import { fetchForDiagnosis } from '../lib/diagnose.js';
import { isIndexed, loadIndexStatus } from '../lib/index-status.js';
import { stripHtml } from '../lib/site-fetch.js';
import { fillTemplate } from '../lib/template.js';
import { MODELS } from '../lib/models.js';
import { loadAlerts, saveAlerts } from '../lib/watch.js';

const ASSESS_PROMPT = readFileSync(new URL('../prompts/assess.md', import.meta.url), 'utf8');

// Weekly run, one call per alert: a handful of calls a month, not one per day.
const MAX_ASSESSMENTS = 3;
const REASSESS_AFTER_DAYS = 28;
const PAGE_WORDS = 4000;
const MAX_FACT_URLS = 10;

// Structured outputs reject maxLength/maxItems: the limits live in the prompt and in cleanAssessment.
const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    likely_causes: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { action: { type: 'string' }, why: { type: 'string' } },
        required: ['action', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['likely_causes', 'actions'],
  additionalProperties: false,
};

// The text ends up in a mail: no markup and no links, whatever the model returns.
function plain(value, max) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanAssessment(parsed, today) {
  return {
    assessed_at: today,
    likely_causes: (parsed?.likely_causes ?? []).slice(0, 3).map(c => plain(c, 200)).filter(Boolean),
    actions: (parsed?.actions ?? []).slice(0, 5)
      .map(a => ({ action: plain(a?.action, 200), why: plain(a?.why, 300) }))
      .filter(a => a.action),
  };
}

const hasNoText = (alert) => alert.diagnosis.codes?.includes('no_text') || alert.diagnosis.urls.some(u => u.findings.some(f => f.code === 'no_text'));

function isCandidate(alert, today) {
  if (alert.diagnosis?.cause !== 'clean') return false;
  return !alert.assessment || alert.assessment.assessed_at <= addDays(today, -REASSESS_AFTER_DAYS);
}

function urlFacts(alert, entries) {
  return alert.diagnosis.urls.slice(0, MAX_FACT_URLS).map((u) => {
    const e = entries.find(x => x.url === u.url) ?? {};
    const hints = u.findings.map(f => f.code).join(', ') || 'none';
    return `- ${u.url}: coverage "${e.coverageState ?? 'n/a'}", last crawl ${e.lastCrawlTime ?? 'n/a'}, robots ${e.robotsTxtState ?? 'n/a'}, Google canonical ${e.googleCanonical ?? 'n/a'}, fetch state ${e.pageFetchState ?? 'n/a'}, hints: ${hints}`;
  }).join('\n');
}

/**
 * Content assessment of open index alerts whose live fetch is clean (cause
 * `clean`): up to 3 per run, `site_not_indexed` first, none that was assessed
 * in the last 28 days. One Sonnet call per alert with the page text as
 * untrusted data. Saved as `alert.assessment`; a dry run only prints. A
 * failing call or a result without actions is a warning (nothing saved), an alert with the `no_text` hint is skipped with a warning, `BudgetExceededError` is rethrown. Returns the
 * new assessments with their `alert_id`.
 */
export async function assessAlerts({ config, cwd = process.cwd(), dryRun = false, warnings = [], today = format(new Date()), fetch = fetchForDiagnosis }) {
  const state = loadAlerts(cwd, warnings);
  // Almost no page text: the model would invent causes.
  const due = state.open.filter(a => isCandidate(a, today));
  for (const a of due.filter(hasNoText)) warnings.push(`Assessment skipped for ${a.id}: page has almost no text (no_text)`);
  const candidates = due
    .filter(a => !hasNoText(a))
    .sort((a, b) => (b.kind === 'site_not_indexed') - (a.kind === 'site_not_indexed'))
    .slice(0, MAX_ASSESSMENTS);
  if (!candidates.length) return [];

  const { entries } = loadIndexStatus(cwd);
  const indexed = entries.filter(e => isIndexed(e.coverageState)).length;
  const done = [];
  for (const alert of candidates) {
    try {
      const page = await fetch(alert.diagnosis.urls[0].url, { locale: defaultLocale(config) });
      const prompt = fillTemplate(ASSESS_PROMPT, {
        kind: alert.kind,
        site_name: config.site_name || config.project || '',
        locale: defaultLocale(config),
        sitemap_urls: entries.length,
        indexed_share: entries.length ? `${indexed} of ${entries.length}` : 'n/a',
        url_facts: urlFacts(alert, entries),
        page_text: stripHtml(page.html).split(/\s+/).slice(0, PAGE_WORDS).join(' '),
      });
      const parsed = await complete({
        system: 'You are an SEO analyst. You judge index coverage from data and say only what the data supports.',
        prompt, model: MODELS.default, maxTokens: 2048, json: true, schema: ASSESS_SCHEMA,
      });
      const assessment = cleanAssessment(parsed, today);
      if (!assessment.actions.length) throw new Error('model returned no actions');
      console.log(chalk.blue(`  Assessment ${alert.id}: ${assessment.likely_causes.join(' | ') || 'no causes named'}`));
      if (!dryRun) {
        alert.assessment = assessment;
        saveAlerts(state, cwd); // per alert, so a later budget stop keeps the earlier ones
      }
      done.push({ alert_id: alert.id, ...assessment });
    } catch (e) {
      rethrowIfBudget(e);
      warnings.push(`Assessment failed for ${alert.id}: ${e.message.split('\n')[0]}`);
    }
  }
  return done;
}
