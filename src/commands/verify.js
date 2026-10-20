import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig, defaultLocale, localeLandingPath, CONFIG_FILE } from '../lib/config.js';
import { commitToBranch } from '../lib/github.js';
import { writeReport } from '../lib/runlog.js';
import { overlayKeyOfFile } from '../steps/overlay.js';
import { verifyPage, renderVerifySection, replaceVerifySection } from '../steps/verify.js';
import { wantsStrict } from './check.js';

// Exit code of a page the verifier could not clear; the gate maps it to `fact_blocked`.
export const EXIT_BLOCKED = 3;

// The locale of a landing page from its path, null for a markdown file outside every landing directory.
function localeOfFile(config, file) {
  const clean = String(file).replace(/^\.\//, '');
  const locales = config.locales?.length ? config.locales : [defaultLocale(config)];
  return locales.find(l => clean.startsWith(`${localeLandingPath(config, l).replace(/^\.\//, '').replace(/\/*$/, '')}/`)) ?? null;
}

// Read-modify-write of the PR body through the gh CLI (the gate has GH_TOKEN), so a rerun replaces the section.
function updatePrBody({ repo, number, section }) {
  const api = (args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8' });
  const body = api([`repos/${repo}/pulls/${number}`, '--jq', '.body // ""']).replace(/\n$/, '');
  api(['-X', 'PATCH', `repos/${repo}/pulls/${number}`, '-f', `body=${replaceVerifySection(body, section)}`]);
}

/**
 * Verifies the given pages and returns `{ code, report }`. Exit 0 also covers
 * "skipped" (non-strict project, nothing to verify). Any page that cannot be
 * cleared, or a verifier that could not run, is code 3. `deps` is injectable so
 * tests stay off GitHub.
 */
export async function runVerify(files, opts = {}, cwd = process.cwd(), deps = {}) {
  const { verify = verifyPage, commit = commitToBranch, writePrBody = updatePrBody } = deps;
  if (!wantsStrict(cwd, opts.strict)) {
    console.log(chalk.gray('seo verify: skipped (project is not quality: strict).'));
    return { code: 0, report: { status: 'skipped', pages: [] } };
  }
  const config = existsSync(join(cwd, CONFIG_FILE)) ? loadConfig(cwd) : null;
  if (!config) {
    console.error(chalk.red('seo verify: seo.config.yaml missing.'));
    return { code: 2, report: { status: 'error', pages: [] } };
  }

  const pages = [];
  const patched = [];
  for (const file of files) {
    const abs = join(cwd, file);
    // Deleted by --merge-from, overlays (no prose to verify) and non-landing markdown have nothing to check.
    const locale = localeOfFile(config, file);
    if (!existsSync(abs) || (config.overlays && overlayKeyOfFile(config, file)) || !locale) {
      console.log(chalk.gray(`seo verify: skipping ${file}`));
      continue;
    }
    console.log(chalk.bold(`\nVerifying ${file}`));
    const markdown = readFileSync(abs, 'utf8');
    try {
      const result = await verify(markdown, config, cwd, { locale });
      pages.push({ file, findings: result.findings, blocked: result.blocked });
      if (result.markdown !== markdown) {
        writeFileSync(abs, result.markdown, 'utf8');
        patched.push({ path: file, content: result.markdown });
      }
    } catch (e) {
      console.error(chalk.red(`  Verify did not run: ${e.message.split('\n')[0]}`));
      pages.push({ file, findings: [], blocked: true, error: e.message.split('\n')[0] });
    }
  }

  const blocked = pages.some(p => p.blocked);
  const report = { status: blocked ? 'blocked' : patched.length ? 'patched' : 'verified', pages };

  if (opts.commit && patched.length) {
    report.head_sha = await commit({
      files: patched,
      message: 'fix(seo): correct facts found by seo verify',
      repo: config.repo,
      branch: opts.branch,
    });
    console.log(`VERIFY_HEAD_SHA=${report.head_sha}`);
  }
  if (opts.pr && config.repo && pages.length) {
    try {
      writePrBody({ repo: config.repo, number: opts.pr, section: renderVerifySection(pages) });
    } catch (e) {
      console.error(chalk.yellow(`seo verify: PR body not updated (${e.message.split('\n')[0]})`));
    }
  }
  if (opts.report) writeReport(opts.report, report);
  console.log(blocked ? chalk.red('\nseo verify BLOCKED') : chalk.green('\nseo verify PASSED'));
  return { code: blocked ? EXIT_BLOCKED : 0, report };
}

export async function verifyCommand(files, opts = {}) {
  if (opts.commit && !opts.branch) {
    console.error(chalk.red('seo verify: --commit needs --branch (the PR head branch).'));
    process.exit(2);
  }
  const { code } = await runVerify(files, opts);
  if (code) process.exit(code);
}
