#!/usr/bin/env node
import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load order: CLI .env first (global API keys), then project .env with override:true so
// project-level settings (e.g. a different ANTHROPIC_API_KEY per project) win.
// Accepted trade-off: a malicious project .env could redirect API tokens.
// Acceptable for a personal CLI run in trusted project directories.
const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv({ path: join(cliDir, '.env') });
dotenv({ path: join(process.cwd(), '.env'), override: true });

import { program } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { runCommand } from '../src/commands/run.js';
import { checkCommand } from '../src/commands/check.js';
import { submitSitemapCommand } from '../src/commands/submit-sitemap.js';
import { indexnowCommand } from '../src/commands/indexnow.js';
import { indexStatusCommand } from '../src/commands/index-status.js';
import { watchCommand } from '../src/commands/watch.js';
import { dashboardCommand } from '../src/commands/dashboard.js';
import { improveCommand } from '../src/commands/improve.js';
import { conversationalCommand } from '../src/commands/conversational.js';

program
  .name('seo')
  .description('SEO landing page automation')
  .version('0.1.0');

program
  .command('init')
  .description('Interactive setup — creates seo.config.yaml in the current project')
  .action(initCommand);

program
  .command('run')
  .description('Discover keywords, generate pages, open PR')
  .option('--dry-run', 'print generated markdown, do not commit or open PR')
  .option('--report <path>', 'write the run report (status, PRs, budget, warnings, errors) as JSON')
  .action(runCommand);

program
  .command('improve')
  .description('Rewrite the existing page with the strongest case for it, based on live Search Console data')
  .option('--dry-run', 'print the rewritten markdown, do not commit or open PR')
  .option('--slug <slug>', 'rewrite this page instead of selecting one from Search Console')
  .option('--merge-from <slugs>', 'with --slug: merge these pages (comma separated) into it, delete them and redirect', (v) => v.split(',').map(x => x.trim()).filter(Boolean))
  .option('--brief <file>', 'with --slug: file with what the rewrite has to fix')
  .option('--report <path>', 'write the run report (status, PRs, warnings, errors) as JSON')
  .action((opts) => improveCommand(opts));

program
  .command('check')
  .description('Validate already-generated landing-page markdown files (CI gate)')
  .argument('<files...>', 'markdown files to validate (e.g. the PR\'s changed .md files)')
  .option('--strict', 'apply the strict quality rules even without `quality: strict` in seo.config.yaml')
  .action(checkCommand);

program
  .command('dashboard')
  .description('Cross-project SEO overview: funnel, rankings, movers, suggestions')
  .option('--live', 'pull current positions/clicks from Search Console per project')
  .option('--project <name>', 'limit to projects whose dir or name matches')
  .option('--json', 'print the aggregated data as JSON')
  .action(dashboardCommand);

program
  .command('conversational')
  .description('Group Search Console queries into AI-Mode artefacts, tracker probes, and real conversational questions')
  .option('--days <n>', 'lookback window in days', '90')
  .option('--json', 'print the grouped data as JSON')
  .action(conversationalCommand);

program
  .command('submit-sitemap')
  .description('(Re)submit <base_url>/sitemap.xml to Google Search Console')
  .action(submitSitemapCommand);

program
  .command('indexnow')
  .description('push all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver)')
  .action(indexnowCommand);

program
  .command('index-status')
  .description('Inspect live Google index status for the sitemap URLs and diff against last week')
  .option('--json', 'print the inspection results and diff as JSON')
  .option('--commit', 'commit seo/index-status.json to main via the GitHub API')
  .action(indexStatusCommand);

program
  .command('watch')
  .description('Daily guard without an LLM: index status and landing page traffic, alerts only for what is new or resolved')
  .option('--commit', 'commit seo/alerts.json and seo/index-status.json to main when they changed')
  .option('--report <path>', 'write the watch result (status, alerts, warnings) as JSON')
  .option('--dry-run', 'do not write seo/alerts.json and do not commit')
  .action(watchCommand);

program.parse();
