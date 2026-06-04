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
import { dashboardCommand } from '../src/commands/dashboard.js';

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
  .action(runCommand);

program
  .command('check')
  .description('Validate already-generated landing-page markdown files (CI gate)')
  .argument('<files...>', 'markdown files to validate (e.g. the PR\'s changed .md files)')
  .action(checkCommand);

program
  .command('dashboard')
  .description('Cross-project SEO overview: funnel, rankings, movers, suggestions')
  .option('--live', 'pull current positions/clicks from Search Console per project')
  .option('--project <name>', 'limit to projects whose dir or name matches')
  .option('--json', 'print the aggregated data as JSON')
  .action(dashboardCommand);

program
  .command('submit-sitemap')
  .description('(Re)submit <base_url>/sitemap.xml to Google Search Console')
  .action(submitSitemapCommand);

program.parse();
