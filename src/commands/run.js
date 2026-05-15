import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { saveKeywords, getPending, KEYWORD_STATUS, saveLastPR } from '../lib/keywords.js';
import { discover } from '../steps/discover.js';
import { generatePage } from '../steps/generate.js';
import { validate } from '../steps/validate.js';
import { createPR } from '../steps/pr.js';
import { track } from '../steps/track.js';

function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SERPAPI_KEY',
  'GITHUB_TOKEN',
];

async function generateForLocale(kw, locale, config, cwd, dryRun, defaultLocale, generatedKeys) {
  const localeLandingPath = config.landing_path.includes(`/${defaultLocale}/`)
    ? config.landing_path.replace(`/${defaultLocale}/`, `/${locale}/`)
    : config.landing_path;
  const localeConfig = { ...config, locale, landing_path: localeLandingPath };
  const label = (config.locales?.length ?? 1) > 1 ? ` [${locale}]` : '';

  const targetFile = join(cwd, localeLandingPath, `${kw.target_slug}.md`);
  if (existsSync(targetFile)) {
    console.log(chalk.gray(`  Skipping ${kw.target_slug}${label} — file already exists`));
    kw.status = KEYWORD_STATUS.DONE;
    return null;
  }
  if (generatedKeys.has(`${kw.target_slug}::${locale}`)) {
    console.log(chalk.yellow(`  Skipping ${kw.target_slug}${label} — slug collision with another keyword`));
    return null;
  }

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
    kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
    return null;
  }

  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${kw.keyword}${label} ---\n`));
    console.log(markdown.slice(0, 600) + '\n...');
    return null;
  }

  const filePath = join(localeLandingPath, `${kw.target_slug}.md`).replace(/\\/g, '/');
  return { keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown };
}

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
  const defaultLocale = config.locales?.[0] ?? config.locale ?? 'de';

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
    const GENERATE_CONCURRENCY = 2;
    const limit = pLimit(GENERATE_CONCURRENCY);
    const generatedKeysAtomic = new Set();
    const tasks = [];
    for (const kw of toGenerate) {
      for (const locale of locales) {
        tasks.push(limit(async () => {
          const page = await generateForLocale(kw, locale, config, cwd, dryRun, defaultLocale, generatedKeysAtomic);
          if (page) {
            generatedKeysAtomic.add(`${page.slug}::${page.locale}`);
            generatedPages.push(page);
            if (kw.status !== KEYWORD_STATUS.PR_OPENED) kw.status = KEYWORD_STATUS.PR_OPENED;
          }
          return page;
        }));
      }
    }
    await Promise.all(tasks);

    if (!dryRun && generatedPages.length > 0) {
      try {
        saveKeywords(keywordsData, cwd);
        const prUrl = await createPR({ generatedPages, keywordsJsonContent: keywordsData, config, cwd });
        // Write PR URL so CI workflows can enable auto-merge
        saveLastPR(prUrl, cwd);
        console.log(chalk.bold(`\nDone. PR: ${prUrl}`));
      } catch (e) {
        console.error(chalk.red(`\nPR creation failed: ${e.message}`));
        // Reset status so keywords are retried next run
        generatedPages.forEach(p => {
          const kw = keywordsData.keywords.find(k => k.keyword === p.keyword);
          if (kw) kw.status = KEYWORD_STATUS.PROPOSED;
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
