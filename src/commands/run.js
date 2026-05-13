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
    console.error(chalk.gray('\nAdd them to /Users/rafael/Local Sites/seo-cli/.env'));
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const dryRun = opts.dryRun ?? false;

  console.log(chalk.bold(`\nseo run — ${config.project} ${dryRun ? '(dry run)' : ''}\n`));

  // 1. Discover
  const keywordsData = await discover(config, cwd);

  // 2. Find pending keywords (proposed + score >= cutoff)
  const pending = getPending(keywordsData, config.score_cutoff);
  const toGenerate = pending.slice(0, config.weekly_cap);

  if (toGenerate.length === 0) {
    console.log(chalk.gray('\nNo keywords to generate. Run again after discovering more.'));
  } else {
    console.log(chalk.bold(`\nGenerating ${toGenerate.length} page(s):\n`));

    const generatedPages = [];

    for (const kw of toGenerate) {
      let markdown;
      let valid = false;

      for (let attempt = 1; attempt <= 2; attempt++) {
        markdown = await generatePage(kw, config, cwd);
        const result = validate(markdown, kw);

        if (result.ok) {
          valid = true;
          break;
        }

        if (attempt === 1) {
          console.log(chalk.yellow(`  Retrying with validator feedback...`));
        }
      }

      if (!valid) {
        console.log(chalk.red(`  Skipping ${kw.keyword} after 2 failed attempts.`));
        kw.status = 'validation_failed';
        continue;
      }

      if (dryRun) {
        console.log(chalk.cyan(`\n--- ${kw.keyword} ---\n`));
        console.log(markdown.slice(0, 600) + '\n...');
        continue;
      }

      const filePath = join(config.landing_path, `${kw.target_slug}.md`).replace(/\\/g, '/');
      generatedPages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, filePath, markdown });
      kw.status = 'pr_opened';
    }

    if (!dryRun && generatedPages.length > 0) {
      saveKeywords(keywordsData, cwd);
      const prUrl = await createPR({ generatedPages, keywordsJsonContent: keywordsData, config, cwd });
      console.log(chalk.bold(`\nDone. PR: ${prUrl}`));
    }
  }

  // 3. Track (always, unless dry run)
  if (!dryRun) {
    console.log('');
    await track(config, cwd);
  }

  console.log(chalk.bold('\nAll done.\n'));
}
