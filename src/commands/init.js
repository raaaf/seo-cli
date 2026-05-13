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
    process.stdout.write(chalk.blue(`\nAnalysiere ${bootstrap.gsc_property}...`));
    try {
      siteData = await analyzeSite(bootstrap.gsc_property);
      process.stdout.write(chalk.green(' fertig.\n\n'));
      console.log(chalk.gray(`  Thema:    ${siteData.topic}`));
      console.log(chalk.gray(`  Cluster:  ${(siteData.clusters || []).join(', ')}`));
      console.log(chalk.gray(`  CTA:      ${siteData.primary_cta}`));
      console.log(chalk.gray(`  Sprache:  ${siteData.locale}`));
      console.log('');

      // Generate style doc from website copy
      const styleDocPath = detected.style_doc || 'docs/writing-style.md';
      process.stdout.write(chalk.blue(`  Schreibstil wird analysiert...`));
      try {
        await generateStyleDoc(bootstrap.gsc_property, styleDocPath, cwd);
        detected.style_doc = styleDocPath;
        process.stdout.write(chalk.green(` gespeichert in ${styleDocPath}\n\n`));
      } catch (e) {
        process.stdout.write(chalk.yellow(` übersprungen (${e.message})\n\n`));
      }
    } catch (e) {
      process.stdout.write(chalk.yellow(` fehlgeschlagen (${e.message})\n\n`));
    }
  }

  // Step 4: only confirm/override what Claude extracted + landing path
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'landing_path',
      message: 'Wo sollen generierte Seiten abgelegt werden?',
      default: existing.landing_path || detected.landing_path || 'resources/landing/de/',
    },
    {
      type: 'list',
      name: 'weekly_cap',
      message: 'Wie viele neue Seiten pro Woche?',
      choices: [
        { name: '1 — ruhig, viel Kontrolle', value: 1 },
        { name: '2 — guter Rhythmus (empfohlen)', value: 2 },
        { name: '4 — aggressiv', value: 4 },
      ],
      default: existing.weekly_cap ?? 2,
    },
    {
      type: 'list',
      name: 'locales',
      message: 'In welcher Sprache sollen Seiten generiert werden?',
      choices: [
        { name: 'Nur Deutsch', value: ['de'] },
        { name: 'Nur Englisch', value: ['en'] },
        { name: 'Deutsch + Englisch (beide in einem Run)', value: ['de', 'en'] },
      ],
      default: existing.locales
        ? JSON.stringify(existing.locales)
        : JSON.stringify(['de']),
    },
    {
      type: 'confirm',
      name: 'confirm_analysis',
      message: `Stimmt die Analyse? (sonst kurz korrigieren)`,
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
        message: 'Worum geht es auf dieser Website?',
        default: siteData.topic || '',
      },
      {
        type: 'input',
        name: 'clusters',
        message: 'Themen-Cluster (kommagetrennt):',
        default: (siteData.clusters || []).join(', '),
      },
      {
        type: 'list',
        name: 'primary_cta',
        message: 'Was sollen Besucher tun?',
        choices: [
          { name: 'Kostenlos registrieren', value: 'trial_signup' },
          { name: 'Demo buchen', value: 'book_demo' },
          { name: 'Kontakt aufnehmen', value: 'contact' },
          { name: 'App herunterladen', value: 'download_app' },
          { name: 'Mehr erfahren / Newsletter', value: 'learn_more' },
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
  console.log(chalk.green('\nConfig gespeichert in seo.config.yaml'));
  console.log(chalk.gray('\nNächster Schritt:'));
  console.log(chalk.white('  seo run --dry-run'));
}
