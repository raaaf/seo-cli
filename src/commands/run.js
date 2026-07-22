import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig, defaultLocale as getDefaultLocale, localeLandingPath as getLocaleLandingPath } from '../lib/config.js';
import { saveKeywords, getPending, KEYWORD_STATUS, saveLastPR } from '../lib/keywords.js';
import { discover } from '../steps/discover.js';
import { generatePage } from '../steps/generate.js';
import { generateCounterpart, linkAlternates } from '../steps/counterpart.js';
import { validate } from '../steps/validate.js';
import { reviewPage, unresolvedSeverity } from '../steps/review.js';
import { improveCommand } from './improve.js';
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

// Generate the counterpart page for an already-validated default-locale page.
// Returns { markdown, slug } on success, or null on any failure (invalid/
// colliding slug after retry, or validation failing after 2 attempts) — a
// counterpart failure never loses the default-locale page, it's just skipped.
async function generateCounterpartPage(kw, sourceMarkdown, config, cwd, dryRun, extraExistingSlugs) {
  const counterpartLocale = config.counterpart_locale;
  const label = ` [${counterpartLocale}]`;

  let markdown;
  let slug;
  let valid = false;
  let lastResult;
  let validatorFeedback = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      ({ markdown, slug } = await generateCounterpart(sourceMarkdown, kw, config, cwd, { validatorFeedback, extraExistingSlugs }));
    } catch (e) {
      console.log(chalk.yellow(`  Counterpart skipped: ${kw.keyword}${label} (${e.message})`));
      return null;
    }
    lastResult = validate(markdown, kw, { counterpart: true });
    if (lastResult.ok) { valid = true; break; }
    validatorFeedback = lastResult.errors.join('\n');
  }

  if (!valid) {
    console.log(chalk.yellow(`  Counterpart skipped: ${kw.keyword}${label} (validation failed after 2 attempts)`));
    (lastResult?.errors ?? []).forEach(e => console.log(chalk.yellow(`    ⚠ ${e}`)));
    return null;
  }

  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${kw.keyword}${label} (slug: ${slug}) ---\n`));
    console.log(markdown.slice(0, 600) + '\n...');
    return null;
  }

  return { markdown, slug };
}

// Generates the default-locale page for `kw`, then (when config.counterpart_locale
// is set) its reciprocal counterpart page. Returns an array of 0-2 page objects
// ({ keyword, slug, score, type, locale, filePath, markdown }).
async function generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeys) {
  const localeLandingPathStr = getLocaleLandingPath(config, locale);
  const localeConfig = { ...config, locale, landing_path: localeLandingPathStr };
  const label = (config.locales?.length ?? 1) > 1 ? ` [${locale}]` : '';

  const targetFile = join(cwd, localeLandingPathStr, `${kw.target_slug}.md`);
  if (existsSync(targetFile)) {
    console.log(chalk.gray(`  Skipping ${kw.target_slug}${label} — file already exists`));
    kw.status = KEYWORD_STATUS.DONE;
    return [];
  }
  if (generatedKeys.has(`${kw.target_slug}::${locale}`)) {
    console.log(chalk.yellow(`  Skipping ${kw.target_slug}${label} — slug collision with another keyword`));
    return [];
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
    (lastResult?.errors ?? []).forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
    return [];
  }

  // Fact check against the live web and against the cluster's published pages.
  // A high-severity finding the reviewer could not patch means the page states
  // something false that we cannot correct automatically — drop it rather than
  // publish it. Everything else is patched and reported.
  if (config.fact_check !== false && !dryRun) {
    const { markdown: reviewed, findings } = await reviewPage(markdown, kw, localeConfig, cwd, { locale });
    if (unresolvedSeverity(findings) === 'high') {
      console.log(chalk.red(`  Skipped: ${kw.keyword}${label} (unresolved factual error, see finding above)`));
      kw.status = KEYWORD_STATUS.VALIDATION_FAILED;
      return [];
    }
    if (reviewed !== markdown) {
      const afterFix = validate(reviewed, kw);
      if (afterFix.ok) {
        markdown = reviewed;
      } else {
        console.log(chalk.yellow('  Fact-check patches broke validation, keeping the unpatched page'));
      }
    }
  }

  if (dryRun) {
    console.log(chalk.cyan(`\n--- ${kw.keyword}${label} ---\n`));
    console.log(markdown.slice(0, 600) + '\n...');
  }

  const hasCounterpart = locale === defaultLocaleVal
    && config.counterpart_locale
    && config.counterpart_locale !== defaultLocaleVal;

  const counterpart = hasCounterpart
    ? await generateCounterpartPage(kw, markdown, config, cwd, dryRun, [...generatedKeys].map(k => k.split('::')[0]))
    : null;

  if (dryRun) {
    return [];
  }

  const filePath = join(localeLandingPathStr, `${kw.target_slug}.md`).replace(/\\/g, '/');
  const pages = [];

  if (counterpart) {
    const linked = linkAlternates(markdown, counterpart.markdown, kw.target_slug, counterpart.slug);
    const counterpartLandingPathStr = getLocaleLandingPath(config, config.counterpart_locale);
    const counterpartFilePath = join(counterpartLandingPathStr, `${counterpart.slug}.md`).replace(/\\/g, '/');
    pages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown: linked.sourceMarkdown });
    pages.push({
      keyword: kw.keyword, slug: counterpart.slug, score: kw.score, type: kw.type,
      locale: config.counterpart_locale, filePath: counterpartFilePath, markdown: linked.counterpartMarkdown,
    });
  } else {
    pages.push({ keyword: kw.keyword, slug: kw.target_slug, score: kw.score, type: kw.type, locale, filePath, markdown });
  }

  return pages;
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
  const defaultLocaleVal = getDefaultLocale(config);

  console.log(chalk.bold(`\nseo run — ${config.project} [${locales.join('+')}] ${dryRun ? '(dry run)' : ''}\n`));

  // 1. Discover
  const keywordsData = await discover(config, cwd);

  // 2. Generate
  const pending = getPending(keywordsData, config.score_cutoff);
  const toGenerate = pending.slice(0, config.weekly_cap);

  if (toGenerate.length === 0) {
    // An empty backlog is the normal state once a topic space is covered. The
    // week is better spent on the pages that already rank and get no clicks
    // than on a keyword invented to fill the slot.
    console.log(chalk.gray('\nNo keywords to generate — switching to improving an existing page.'));
    if (!dryRun) await improveCommand({ config, dryRun }, cwd);
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
          const pages = await generateForLocale(kw, locale, config, cwd, dryRun, defaultLocaleVal, generatedKeysAtomic);
          for (const page of pages) {
            generatedKeysAtomic.add(`${page.slug}::${page.locale}`);
            generatedPages.push(page);
            if (kw.status !== KEYWORD_STATUS.PR_OPENED) kw.status = KEYWORD_STATUS.PR_OPENED;
          }
          return pages;
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
