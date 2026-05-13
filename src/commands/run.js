import { join } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { saveKeywords, getPending } from '../lib/keywords.js';
import { discover } from '../steps/discover.js';
import { generatePage } from '../steps/generate.js';
import { validate } from '../steps/validate.js';
import { createPR } from '../steps/pr.js';
import { track } from '../steps/track.js';

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SERPAPI_KEY',
  'GITHUB_TOKEN',
];

export async function runCommand(opts) {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(chalk.red('\nMissing env vars:'));
    missing.forEach(k => console.error(chalk.red(`  ${k}`)));
    console.error(chalk.gray('\nAdd them to the seo-cli .env file'));
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const dryRun = opts.dryRun ?? false;
  const locales = config.locales || [config.locale || 'de'];

  console.log(chalk.bold(`\nseo run — ${config.project} [${locales.join('+')}] ${dryRun ? '(dry run)' : ''}\n`));

  // 1. Discover
  const keywordsData = await discover(config, cwd);

  // 2. Generate
  const pending = getPending(keywordsData, config.score_cutoff);
  const toGenerate = pending.slice(0, config.weekly_cap);

  if (toGenerate.length === 0) {
    console.log(chalk.gray('\nNo keywords to generate. Next run will surface new suggestions.'));
  } else {
    console.log(chalk.bold(`\nGenerating ${toGenerate.length} page(s):\n`));

    const generatedPages = [];

    for (const kw of toGenerate) {
      for (const locale of locales) {
        const localeConfig = { ...config, locale };
        const label = locales.length > 1 ? ` [${locale}]` : '';

        let markdown;
        let valid = false;
        let lastResult;

        for (let attempt = 1; attempt <= 2; attempt++) {
          markdown = await generatePage(kw, localeConfig, cwd, attempt > 1 ? lastResult : null);
          lastResult = validate(markdown, kw);
          if (lastResult.ok) { valid = true; break; }
        }

        if (!valid) {
          console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (validation failed after 2 attempts)`));
          kw.status = 'validation_failed';
          continue;
        }

        if (dryRun) {
          console.log(chalk.cyan(`\n--- ${kw.keyword}${label} ---\n`));
          console.log(markdown.slice(0, 600) + '\n...');
          continue;
        }

        // Landing path: swap locale segment if multi-locale
        const landingPath = locales.length > 1
          ? config.landing_path.replace(/\/(de|en)\//, `/${locale}/`)
          : config.landing_path;

        const filePath = join(landingPath, `${kw.target_slug}.md`).replace(/\\/g, '/');
        generatedPages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown });
      }

      kw.status = 'pr_opened';
    }

    if (!dryRun && generatedPages.length > 0) {
      try {
        saveKeywords(keywordsData, cwd);
        const prUrl = await createPR({ generatedPages, keywordsJsonContent: keywordsData, config, cwd });
        console.log(chalk.bold(`\nDone. PR: ${prUrl}`));
      } catch (e) {
        console.error(chalk.red(`\nPR creation failed: ${e.message}`));
        // Reset status so keywords are retried next run
        generatedPages.forEach(p => {
          const kw = keywordsData.keywords.find(k => k.keyword === p.keyword);
          if (kw) kw.status = 'proposed';
        });
        saveKeywords(keywordsData, cwd);
      }
    }
  }

  // 3. Track
  if (!dryRun) {
    console.log('');
    await track(config, cwd);
  }

  console.log(chalk.bold('\nAll done.\n'));
}
