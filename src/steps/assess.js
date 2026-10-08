import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { complete } from '../lib/claude.js';
import { rethrowIfBudget } from '../lib/budget.js';
import { defaultLocale } from '../lib/config.js';
import { format } from '../lib/date.js';
import { addDays } from '../lib/measure.js';
import { loadChanges } from '../lib/changes.js';
import { fetchForDiagnosis } from '../lib/diagnose.js';
import { fetchIndexStatus, isIndexed, loadIndexStatus } from '../lib/index-status.js';
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
const CHANGES_WINDOW_DAYS = 56;
const MAX_CHANGES = 20;
const MAX_LINKS = 80;
const MAX_COMMITS = 30;
const ASSET_EXT = /\.(?:css|js|mjs|map|json|xml|txt|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|mp4|webm|mp3|wav)$/i;

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
    likely_causes: (parsed?.likely_causes ?? []).slice(0, 3).map(c => plain(c, 300)).filter(Boolean),
    actions: (parsed?.actions ?? []).slice(0, 5)
      .map(a => ({ action: plain(a?.action, 300), why: plain(a?.why, 450) }))
      .filter(a => a.action),
  };
}

const hasNoText = (alert) => alert.diagnosis.codes?.includes('no_text') || alert.diagnosis.urls.some(u => u.findings.some(f => f.code === 'no_text'));

const trimSlash = u => String(u).replace(/\/+$/, '');

// Ledger entries; empty when the ledger is unreadable.
function loadLedger(cwd) {
  try {
    return loadChanges(cwd).entries;
  } catch {
    return [];
  }
}

// Newest merge of any age that concerns the alert: any entry for site_not_indexed, else entries touching one of its URLs. Null when there is none.
function lastChangeDate(alert, ledger) {
  const urls = new Set((alert.diagnosis?.urls ?? []).map(u => trimSlash(u.url)));
  return ledger
    .filter(e => alert.kind === 'site_not_indexed' || (e.urls ?? []).some(u => urls.has(trimSlash(u))))
    .map(e => e.merged_at).filter(Boolean).sort().at(-1) ?? null;
}

// Bounded wait: after REASSESS_AFTER_DAYS the alert is assessed anyway, the stored crawl time can lag.
function isWaiting(alert, lastChange, entries, today) {
  if (!lastChange || lastChange <= addDays(today, -REASSESS_AFTER_DAYS)) return false;
  const urls = new Set(alert.diagnosis.urls.map(u => u.url));
  return !entries.some(e => urls.has(e.url) && e.lastCrawlTime && e.lastCrawlTime.slice(0, 10) > lastChange);
}

function isDue(alert, today, lastChange) {
  if (alert.diagnosis?.cause !== 'clean') return false;
  const a = alert.assessment;
  return !a || a.assessed_at <= addDays(today, -REASSESS_AFTER_DAYS) || (lastChange !== null && a.assessed_at < lastChange);
}

/** Same-host `<a href>` targets as sorted, deduplicated paths without query, hash and asset files. */
export function internalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const paths = new Set();
  for (const m of String(html ?? '').matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try {
      const u = new URL((m[1] ?? m[2]).trim(), base);
      if (!/^https?:$/.test(u.protocol) || u.host !== base.host) continue;
      if (ASSET_EXT.test(u.pathname)) continue;
      paths.add(u.pathname);
    } catch { /* unparsable href */ }
  }
  return [...paths].sort().slice(0, MAX_LINKS);
}

const gitLogDefault = (cwd, since) => execFileSync('git', ['log', `--since=${since}`, '--no-merges', '--format=%cs %s', '-n', '300'], { cwd, encoding: 'utf8' });

function recentCommits(cwd, today, gitLog) {
  try {
    const lines = gitLog(cwd, addDays(today, -CHANGES_WINDOW_DAYS)).split('\n')
      .map(l => l.trim()).filter(Boolean)
      .filter((l) => { const subject = l.slice(l.indexOf(' ') + 1); return !subject.startsWith('seo:') && !subject.includes('[skip ci]'); })
      .slice(0, MAX_COMMITS)
      .map(l => `- ${l}`);
    return lines.join('\n') || 'none';
  } catch {
    return 'unknown (no git history)';
  }
}

function urlFacts(alert, entries) {
  return alert.diagnosis.urls.slice(0, MAX_FACT_URLS).map((u) => {
    const e = entries.find(x => x.url === u.url) ?? {};
    const hints = u.findings.map(f => f.code).join(', ') || 'none';
    return `- ${u.url}: coverage "${e.coverageState ?? 'n/a'}", last crawl ${e.lastCrawlTime ?? 'n/a'}, robots ${e.robotsTxtState ?? 'n/a'}, Google canonical ${e.googleCanonical ?? 'n/a'}, fetch state ${e.pageFetchState ?? 'n/a'}, hints: ${hints}`;
  }).join('\n');
}

function recentChanges(cwd, today, warnings) {
  try {
    const since = addDays(today, -CHANGES_WINDOW_DAYS);
    const lines = loadChanges(cwd).entries
      .filter(e => e.merged_at >= since && e.merged_at <= today)
      .sort((a, b) => b.merged_at.localeCompare(a.merged_at))
      .slice(0, MAX_CHANGES)
      .map(e => `- ${e.merged_at}: ${e.kind === 'new' ? 'new page' : 'rewrite'} ${e.slug}${e.revert_candidate ? ' (performs worse than before, may need reverting)' : ''}`);
    return lines.join('\n') || 'none';
  } catch {
    warnings.push('Assessment: changes.json unreadable');
    return 'unknown (change history unreadable)';
  }
}

/**
 * Content assessment of open index alerts whose live fetch is clean (cause
 * `clean`): up to 3 per run, `site_not_indexed` first, none that was assessed
 * in the last 28 days. One Sonnet call per alert with the page text as
 * untrusted data. Saved as `alert.assessment`; a dry run only prints. A
 * failing call or a result without actions is a warning (nothing saved), an alert with the `no_text` hint is skipped with a warning, `BudgetExceededError` is rethrown. Returns the
 * new assessments with their `alert_id`. Alerts that wait for a recrawl after
 * the newest change (at most 28 days) are pushed into `waiting` as `{ alert_id, last_change }`.
 */
export async function assessAlerts({ config, cwd = process.cwd(), dryRun = false, warnings = [], waiting = [], today = format(new Date()), fetch = fetchForDiagnosis, gitLog = gitLogDefault, inspect = urls => fetchIndexStatus(config, urls) }) {
  const state = loadAlerts(cwd, warnings);
  // Almost no page text: the model would invent causes.
  const ledger = loadLedger(cwd);
  const { entries } = loadIndexStatus(cwd);
  const due = [];
  for (const a of state.open) {
    const lastChange = lastChangeDate(a, ledger);
    if (!isDue(a, today, lastChange)) continue;
    if (!isWaiting(a, lastChange, entries, today)) { due.push(a); continue; }
    // The stored crawl time lags: look at the alert's URLs live before waiting.
    let live = null;
    try {
      live = await inspect(a.diagnosis.urls.slice(0, MAX_FACT_URLS).map(u => u.url));
    } catch {
      warnings.push(`Assessment: live crawl check failed for ${a.id}`);
    }
    if (live && !isWaiting(a, lastChange, live, today)) due.push(a);
    else waiting.push({ alert_id: a.id, last_change: lastChange });
  }
  for (const a of due.filter(hasNoText)) warnings.push(`Assessment skipped for ${a.id}: page has almost no text (no_text)`);
  const candidates = due
    .filter(a => !hasNoText(a))
    .sort((a, b) => (b.kind === 'site_not_indexed') - (a.kind === 'site_not_indexed'))
    .slice(0, MAX_ASSESSMENTS);
  if (!candidates.length) return [];

  const indexed = entries.filter(e => isIndexed(e.coverageState)).length;
  const recent_changes = recentChanges(cwd, today, warnings);
  const recent_commits = recentCommits(cwd, today, gitLog);
  const locale = defaultLocale(config);
  let homeLinks;
  let homeFailed = false;
  const done = [];
  for (const alert of candidates) {
    try {
      const pageUrl = alert.diagnosis.urls[0].url;
      const page = await fetch(pageUrl, { locale });
      const links = internalLinks(page.html, pageUrl);
      if (trimSlash(pageUrl) !== trimSlash(config.base_url)) {
        if (homeLinks === undefined) {
          try { homeLinks = internalLinks((await fetch(config.base_url, { locale })).html, config.base_url); } catch {
            homeLinks = [];
            homeFailed = true;
            warnings.push('Assessment: home page links unavailable');
          }
        }
        links.push(...homeLinks);
      }
      const merged = [...new Set(links)].sort();
      const lines = merged.slice(0, MAX_LINKS);
      if (merged.length > MAX_LINKS) lines.push(`(list cut at ${MAX_LINKS} links)`);
      if (homeFailed) lines.push('(home page links unavailable)');
      const page_links = lines.join('\n') || 'none';
      const prompt = fillTemplate(ASSESS_PROMPT, {
        kind: alert.kind,
        site_name: config.site_name || config.project || '',
        locale: defaultLocale(config),
        today,
        sitemap_urls: entries.length,
        indexed_share: entries.length ? `${indexed} of ${entries.length}` : 'n/a',
        recent_changes,
        recent_commits,
        page_links,
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
