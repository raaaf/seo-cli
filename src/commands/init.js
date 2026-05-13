import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, saveConfig, DEFAULTS } from '../lib/config.js';
import { detectProject } from '../lib/detect.js';
import { analyzeSite } from '../lib/analyze-site.js';
import { generateStyleDoc } from '../lib/generate-style-doc.js';

export async function initCommand() {
  const cwd = process.cwd();
  const configPath = join(cwd, 'seo.config.yaml');

  let existing = {};
  if (existsSync(configPath)) {
    existing = loadConfig(cwd);
    console.log(chalk.gray('Found existing seo.config.yaml — updating.\n'));
  }

  // Step 1: detect from filesystem
  const detected = detectProject(cwd);

  // Step 2: ask only for URL + repo (minimum needed to start)
  const bootstrap = await inquirer.prompt([
    {
      type: 'input',
      name: 'repo',
      message: 'GitHub Repo (owner/name):',
      default: existing.repo || detected.repo || '',
      validate: v => v.includes('/') || 'Format: owner/name',
    },
    {
      type: 'input',
      name: 'gsc_property',
      message: 'Website URL (wie in Google Search Console):',
      default: existing.gsc_property || detected.gsc_property || '',
      validate: v => v.startsWith('http') || 'Muss mit http(s):// beginnen',
    },
  ]);

  // Step 3: Claude reads the site and extracts everything
  let siteData = {};
  if (bootstrap.gsc_property) {
    process.stdout.write(chalk.blue(`\nAnalysing ${bootstrap.gsc_property}...`));
    try {
      siteData = await analyzeSite(bootstrap.gsc_property);
      process.stdout.write(chalk.green(' done.\n\n'));
      console.log(chalk.gray(`  Topic:    ${siteData.topic}`));
      console.log(chalk.gray(`  Clusters: ${(siteData.clusters || []).join(', ')}`));
      console.log(chalk.gray(`  CTA:      ${siteData.primary_cta}`));
      console.log(chalk.gray(`  Locale:   ${siteData.locale}`));
      console.log('');

      // Generate style doc from website copy
      const styleDocPath = detected.style_doc || 'docs/writing-style.md';
      process.stdout.write(chalk.blue(`  Analysing writing style...`));
      try {
        await generateStyleDoc(bootstrap.gsc_property, styleDocPath, cwd);
        detected.style_doc = styleDocPath;
        process.stdout.write(chalk.green(` saved to ${styleDocPath}\n\n`));
      } catch (e) {
        process.stdout.write(chalk.yellow(` skipped (${e.message})\n\n`));
      }
    } catch (e) {
      process.stdout.write(chalk.yellow(` failed (${e.message})\n\n`));
    }
  }

  // Step 4: only confirm/override what Claude extracted + landing path
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'landing_path',
      message: 'Where should generated pages be saved?',
      default: existing.landing_path || detected.landing_path || 'resources/landing/de/',
    },
    {
      type: 'list',
      name: 'weekly_cap',
      message: 'How many new pages per week?',
      choices: [
        { name: '1 — slow, maximum control', value: 1 },
        { name: '2 — good rhythm (recommended)', value: 2 },
        { name: '4 — aggressive', value: 4 },
      ],
      default: existing.weekly_cap ?? 2,
    },
    {
      type: 'list',
      name: 'locales',
      message: 'Which language(s) should pages be generated in?',
      choices: [
        { name: 'German only', value: ['de'] },
        { name: 'English only', value: ['en'] },
        { name: 'German + English (both in one run)', value: ['de', 'en'] },
      ],
      default: existing.locales
        ? JSON.stringify(existing.locales)
        : JSON.stringify(['de']),
    },
    {
      type: 'confirm',
      name: 'confirm_analysis',
      message: `Does the analysis look right?`,
      default: true,
      when: () => !!siteData.topic,
    },
  ]);

  // Allow manual correction if analysis was wrong
  let finalSiteData = siteData;
  if (answers.confirm_analysis === false) {
    const correction = await inquirer.prompt([
      {
        type: 'input',
        name: 'topic',
        message: 'What does this website do and for whom?',
        default: siteData.topic || '',
      },
      {
        type: 'input',
        name: 'clusters',
        message: 'Topic clusters (comma-separated):',
        default: (siteData.clusters || []).join(', '),
      },
      {
        type: 'list',
        name: 'primary_cta',
        message: 'What should visitors do?',
        choices: [
          { name: 'Sign up for free', value: 'trial_signup' },
          { name: 'Book a demo', value: 'book_demo' },
          { name: 'Get in touch', value: 'contact' },
          { name: 'Download the app', value: 'download_app' },
          { name: 'Learn more / newsletter', value: 'learn_more' },
        ],
        default: siteData.primary_cta || 'trial_signup',
      },
    ]);
    finalSiteData = {
      ...siteData,
      topic: correction.topic,
      clusters: correction.clusters.split(',').map(s => s.trim()).filter(Boolean),
      primary_cta: correction.primary_cta,
    };
  }

  const config = {
    project: bootstrap.repo.split('/')[1],
    repo: bootstrap.repo,
    gsc_property: bootstrap.gsc_property,
    base_url: bootstrap.gsc_property.replace(/\/$/, ''),
    site_name: finalSiteData.topic?.split(' ').slice(0, 3).join(' ') || bootstrap.repo.split('/')[1],
    landing_path: answers.landing_path,
    locales: answers.locales,
    locale: answers.locales[0],
    primary_cta: finalSiteData.primary_cta || detected.primary_cta || DEFAULTS.primary_cta,
    style_doc: detected.style_doc || null,
    score_cutoff: DEFAULTS.score_cutoff,
    weekly_cap: answers.weekly_cap,
    clusters: finalSiteData.clusters || detected.clusters || [],
    topic: finalSiteData.topic || '',
  };

  saveConfig(config, cwd);
  console.log(chalk.green('\nConfig saved to seo.config.yaml'));
  console.log(chalk.gray('\nNext:'));
  console.log(chalk.white('  seo run --dry-run'));
}
