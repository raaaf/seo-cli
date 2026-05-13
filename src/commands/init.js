import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, saveConfig, DEFAULTS } from '../lib/config.js';
import { detectProject } from '../lib/detect.js';

export async function initCommand() {
  const cwd = process.cwd();
  const configPath = join(cwd, 'seo.config.yaml');

  let existing = {};
  if (existsSync(configPath)) {
    existing = loadConfig(cwd);
    console.log(chalk.gray('Found existing seo.config.yaml — updating values (Enter to keep current).\n'));
  } else {
    console.log(chalk.blue('Analysing project...\n'));
    const detected = detectProject(cwd);
    const found = Object.entries(detected).filter(([, v]) => v != null);
    if (found.length > 0) {
      console.log(chalk.gray('Detected:'));
      for (const [k, v] of found) {
        console.log(chalk.gray(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`));
      }
      console.log('');
    }
    existing = detected;
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'repo',
      message: 'GitHub Repo (owner/name):',
      default: existing.repo || '',
      validate: v => v.includes('/') || 'Format: owner/name',
    },
    {
      type: 'input',
      name: 'gsc_property',
      message: 'GSC Property URL:',
      default: existing.gsc_property || '',
      validate: v => v.startsWith('http') || 'Must start with http(s)://',
    },
    {
      type: 'input',
      name: 'landing_path',
      message: 'Landing pages path (where .md files go):',
      default: existing.landing_path || 'resources/landing/de/',
    },
    {
      type: 'input',
      name: 'locale',
      message: 'Locale:',
      default: existing.locale || DEFAULTS.locale,
    },
    {
      type: 'input',
      name: 'primary_cta',
      message: 'Primary CTA:',
      default: existing.primary_cta || DEFAULTS.primary_cta,
    },
    {
      type: 'input',
      name: 'style_doc',
      message: "Path to style doc (empty = Rafael's default style):",
      default: existing.style_doc || '',
    },
    {
      type: 'number',
      name: 'score_cutoff',
      message: 'Min score for auto-approve (0–10):',
      default: existing.score_cutoff ?? DEFAULTS.score_cutoff,
    },
    {
      type: 'number',
      name: 'weekly_cap',
      message: 'Max pages to generate per run:',
      default: existing.weekly_cap ?? DEFAULTS.weekly_cap,
    },
    {
      type: 'input',
      name: 'clusters',
      message: 'Topic clusters (comma-separated):',
      default: (existing.clusters || []).join(', '),
    },
  ]);

  const config = {
    project: answers.repo.split('/')[1],
    repo: answers.repo,
    gsc_property: answers.gsc_property,
    landing_path: answers.landing_path,
    locale: answers.locale,
    primary_cta: answers.primary_cta,
    style_doc: answers.style_doc || null,
    score_cutoff: answers.score_cutoff,
    weekly_cap: answers.weekly_cap,
    clusters: answers.clusters.split(',').map(s => s.trim()).filter(Boolean),
  };

  saveConfig(config, cwd);
  console.log(chalk.green('\nConfig saved to seo.config.yaml'));
  console.log(chalk.gray('\nNext steps:'));
  console.log(chalk.white('  1. Copy .env.example to .env and fill in your API keys'));
  console.log(chalk.white('  2. seo run --dry-run'));
}
