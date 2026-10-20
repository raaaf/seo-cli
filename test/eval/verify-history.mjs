#!/usr/bin/env node
// Acceptance eval for `seo verify`, real API, not part of `npm test`.
//
//   node test/eval/verify-history.mjs [--runs 3] [--only positives|negatives|planted] [--dry]
//
// Needs `gh` (read access to rafaelalex-dev/zeit and raaaf/shop-alex) and LLM credentials as
// `seo` itself reads them (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
//
// Positives: the pages as they stood before the human fixes of three zeit SEO PRs (#405 arithmetic,
// #478 law, #480 third-party price). Each must be flagged and patched so the wrong wording is gone.
// Negatives: the zeit SEO PRs merged without a human fix and the two shop PRs, plus three current
// zeit pages. Verify must raise no blocking finding on them.
// Planted: three errors (one per class) written into current zeit pages by the author of this file.
// They were written after the prompt was last tuned and are not to be tuned against.
//
// Pass over the runs: every positive and planted case caught in every run, and at most 1 in 10
// negative pages blocked per run. Prompt tuning only against positives and negatives.
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyPage } from '../../src/steps/verify.js';

const ZEIT = 'rafaelalex-dev/zeit';
const SHOP = 'raaaf/shop-alex';
const LANDING = /^(resources\/landing\/de|content\/landing\/de)\/[^/]+\.md$/;

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const RUNS = Number(flag('runs', 3));
const ONLY = flag('only', null);
const DRY = args.includes('--dry');

const gh = (...a) => execFileSync('gh', ['api', ...a], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const ghJson = (...a) => JSON.parse(gh(...a));
const raw = (repo, path, ref) => gh('-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}?ref=${ref}`);

function pagesAt(repo, ref, paths) {
  return paths.map(path => ({ path, content: raw(repo, path, ref) }));
}

function positive(id, commit, wrong) {
  const { parents, files } = ghJson(`repos/${ZEIT}/commits/${commit}`);
  const before = parents[0].sha;
  return { id, kind: 'positive', repo: ZEIT, wrong, pages: pagesAt(ZEIT, before, files.map(f => f.filename).filter(f => LANDING.test(f))) };
}

function negativePR(repo, number) {
  const pr = ghJson(`repos/${repo}/pulls/${number}`);
  const files = ghJson(`repos/${repo}/pulls/${number}/files?per_page=100`)
    .filter(f => f.status !== 'removed' && LANDING.test(f.filename)).map(f => f.filename);
  return { id: `${repo.split('/')[1]}#${number}`, kind: 'negative', repo, pages: pagesAt(repo, pr.head.sha, files) };
}

// The three current zeit pages that have gone unchanged the longest.
function staleCurrentPages() {
  const names = ghJson(`repos/${ZEIT}/contents/resources/landing/de?ref=main`).map(f => f.name).filter(n => n.endsWith('.md'));
  const dated = names.map(name => {
    const path = `resources/landing/de/${name}`;
    const [{ commit }] = ghJson(`repos/${ZEIT}/commits?path=${path}&per_page=1`);
    return { path, date: commit.committer.date };
  }).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  return dated.map(d => ({
    id: `zeit main ${d.path.split('/').pop()} (last change ${d.date.slice(0, 10)})`,
    kind: 'negative', repo: ZEIT, pages: pagesAt(ZEIT, 'main', [d.path]),
  }));
}

// One wrong claim per class written into an otherwise current page.
const PLANTED = [
  { id: 'planted calculation', path: 'resources/landing/de/stundensatz-berechnen-freelancer.md', from: 'etwa 93 Euro Mindest- und 107 Euro Zielsatz', to: 'etwa 83 Euro Mindest- und 107 Euro Zielsatz', wrong: [/etwa 83 Euro Mindest/] },
  { id: 'planted law', path: 'resources/landing/de/freiberufler-rechnung-pflichtangaben.md', from: '§34a UStDV', to: '§35 UStDV', all: true, wrong: [/§35 UStDV/] },
  { id: 'planted price', path: 'resources/landing/de/zeiterfassung-freelancer-software.md', from: 'Toggl Track für bis zu drei', to: 'Toggl Track für bis zu zehn', wrong: [/Toggl Track für bis zu zehn/] },
];

function plantedCase(p) {
  const content = raw(ZEIT, p.path, 'main');
  if (!content.includes(p.from)) throw new Error(`${p.id}: anchor not found in ${p.path}, the page changed`);
  const planted = p.all ? content.split(p.from).join(p.to) : content.replace(p.from, p.to);
  return { id: p.id, kind: 'planted', repo: ZEIT, wrong: p.wrong, pages: [{ path: p.path, content: planted }] };
}

function buildCases() {
  const cases = [];
  if (!ONLY || ONLY === 'positives') {
    cases.push(
      positive('#405 arithmetic', '4d2fb3b', [/85 bis 110 Euro/, /85 und 110 Euro/, /rund 90 Euro Mindestsatz/]),
      positive('#478 law', '8819f0e', [/bis zur Unanfechtbarkeit/]),
      positive('#480 third-party price', 'f5efb85', [/Toggl Track[^.|]{0,60}fünf/, /Toggl Track \| bis 5 Nutzer/, /monatlich 10 US-Dollar/, /10 USD monatlich/]),
    );
  }
  if (!ONLY || ONLY === 'negatives') {
    cases.push(...[481, 479, 417, 414, 391].map(n => negativePR(ZEIT, n)), ...[13, 14].map(n => negativePR(SHOP, n)), ...staleCurrentPages());
  }
  if (!ONLY || ONLY === 'planted') cases.push(...PLANTED.map(plantedCase));
  return cases;
}

// A temp project root: product facts of zeit when the repo has them, so the product-claim rule is exercised.
function projectRoot(repo) {
  const cwd = mkdtempSync(join(tmpdir(), 'seo-eval-'));
  if (repo === ZEIT) {
    try {
      mkdirSync(join(cwd, 'seo'), { recursive: true });
      writeFileSync(join(cwd, 'seo/product-facts.md'), raw(ZEIT, 'seo/product-facts.md', 'main'));
    } catch { /* no product facts on main: verify runs without that block */ }
  }
  return cwd;
}

async function runCase(c) {
  const cwd = projectRoot(c.repo);
  const config = { project: c.repo.split('/')[1], site_name: c.repo.split('/')[1], locale: 'de', quality: 'strict' };
  let flagged = false;
  let blocked = false;
  let patched = false;
  let wrongLeft = false;
  for (const page of c.pages) {
    const result = await verifyPage(page.content, config, cwd, { locale: 'de' });
    flagged ||= result.findings.length > 0;
    blocked ||= result.blocked;
    patched ||= result.markdown !== page.content;
    wrongLeft ||= (c.wrong ?? []).some(re => re.test(result.markdown));
  }
  const caught = flagged && !blocked && !wrongLeft;
  return { caught, blocked, patched };
}

const cases = buildCases();
console.log(`${cases.length} cases: ${cases.map(c => `${c.kind}:${c.id}`).join(' | ')}`);
if (DRY) {
  for (const c of cases) console.log(`  ${c.kind} ${c.id}: ${c.pages.map(p => `${p.path} (${p.content.length} chars)`).join(', ')}`);
  process.exit(0);
}

const perRun = [];
for (let run = 1; run <= RUNS; run++) {
  console.log(`\n=== run ${run}/${RUNS} ===`);
  const results = [];
  for (const c of cases) {
    results.push({ c, ...(await runCase(c)) });
    const r = results.at(-1);
    console.log(`${c.kind.padEnd(8)} ${c.id}: ${c.kind === 'negative' ? (r.blocked ? 'BLOCKED' : r.patched ? 'patched (page changed)' : 'clean') : (r.caught ? 'caught' : 'MISSED')}`);
  }
  perRun.push(results);
}

const missed = cases.filter(c => c.kind !== 'negative' && perRun.some(rs => !rs.find(r => r.c === c).caught));
const negatives = cases.filter(c => c.kind === 'negative');
const blockedRates = perRun.map(rs => rs.filter(r => r.c.kind === 'negative' && r.blocked).length / Math.max(negatives.length, 1));
const pass = missed.length === 0 && blockedRates.every(rate => rate <= 0.1);
console.log(`\nmissed in at least one run: ${missed.map(c => c.id).join(', ') || 'none'}`);
console.log(`false blocking rate per run: ${blockedRates.map(r => `${(r * 100).toFixed(0)}%`).join(', ')}`);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
