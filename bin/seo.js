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

program.parse();
