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
      message: 'Website URL (wie in Google Search Console eingetragen):',
      default: existing.gsc_property || '',
      validate: v => v.startsWith('http') || 'Muss mit http(s):// beginnen',
    },
    {
      type: 'input',
      name: 'landing_path',
      message: 'Wo sollen die generierten Seiten abgelegt werden?',
      default: existing.landing_path || 'resources/landing/de/',
    },
    {
      type: 'input',
      name: 'topic',
      message: 'Worum geht es auf dieser Website? (1–2 Sätze):',
      default: existing.topic || '',
    },
    {
      type: 'list',
      name: 'primary_cta',
      message: 'Was sollen Besucher auf den Seiten tun?',
      choices: [
        { name: 'Kostenlos registrieren', value: 'trial_signup' },
        { name: 'Demo buchen', value: 'book_demo' },
        { name: 'Kontakt aufnehmen', value: 'contact' },
        { name: 'App herunterladen', value: 'download_app' },
        { name: 'Mehr erfahren / Newsletter', value: 'learn_more' },
      ],
      default: existing.primary_cta || 'trial_signup',
    },
    {
      type: 'list',
      name: 'weekly_cap',
      message: 'Wie viele neue Seiten soll das Tool pro Woche erstellen?',
      choices: [
        { name: '1 Seite — ruhig, viel Kontrolle', value: 1 },
        { name: '2 Seiten — guter Rhythmus (empfohlen)', value: 2 },
        { name: '4 Seiten — aggressiv', value: 4 },
      ],
      default: existing.weekly_cap ?? 2,
    },
    {
      type: 'input',
      name: 'locale',
      message: 'Sprache der Seiten (de / en):',
      default: existing.locale || 'de',
    },
  ]);

  // Derive clusters from topic via Claude if not already set
  let clusters = existing.clusters || [];
  if (!clusters.length && answers.topic) {
    process.stdout.write(chalk.gray('  Themen-Cluster werden abgeleitet...'));
    try {
      const { complete } = await import('../lib/claude.js');
      const result = await complete({
        system: 'Antworte ausschließlich mit einem JSON-Array aus Strings.',
        prompt: `Website-Beschreibung: "${answers.topic}"\n\nLeite 3–5 prägnante Themen-Cluster ab (je 2–4 Wörter, Deutsch). Nur das JSON-Array, kein Text.`,
        json: true,
      });
      clusters = Array.isArray(result) ? result : [];
      process.stdout.write(` ${clusters.join(', ')}\n`);
    } catch {
      process.stdout.write(' übersprungen\n');
    }
  }

  const config = {
    project: answers.repo.split('/')[1],
    repo: answers.repo,
    gsc_property: answers.gsc_property,
    landing_path: answers.landing_path,
    locale: answers.locale,
    primary_cta: answers.primary_cta,
    style_doc: existing.style_doc || null,
    score_cutoff: DEFAULTS.score_cutoff,
    weekly_cap: answers.weekly_cap,
    clusters,
    topic: answers.topic,
  };

  saveConfig(config, cwd);
  console.log(chalk.green('\nConfig saved to seo.config.yaml'));
  console.log(chalk.gray('\nNext steps:'));
  console.log(chalk.white('  1. Copy .env.example to .env and fill in your API keys'));
  console.log(chalk.white('  2. seo run --dry-run'));
}
