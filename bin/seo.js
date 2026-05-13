#!/usr/bin/env node
import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load global keys from seo-cli dir, then project .env overrides
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
