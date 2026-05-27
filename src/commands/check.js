import { readFileSync, existsSync } from 'fs';
import { basename, join } from 'path';
import chalk from 'chalk';
import { loadKeywords } from '../lib/keywords.js';
import { validate } from '../steps/validate.js';
import { parseFrontmatter } from '../lib/frontmatter.js';

function slugFromPath(filePath) {
  return basename(filePath).replace(/\.md$/i, '');
}

// Recover the target keyword for a page so validate() can run its keyword-aware checks.
// Falls back to the slug words when the keyword entry is missing — the hard gate checks
// (frontmatter, lengths, fabricated claims, em-dash, emoji, digits) do not depend on it.
function keywordFor(slug, keywordsData, frontmatter) {
  const entry = keywordsData.keywords.find(k => k.target_slug === slug)
    || keywordsData.keywords.find(k => k.target_slug === frontmatter?.slug);
  if (entry) {
    return { keyword: entry.keyword, expected_entities: entry.expected_entities || [] };
  }
  return { keyword: slug.replace(/-/g, ' '), expected_entities: [] };
}

export async function checkCommand(files) {
  const cwd = process.cwd();
  const keywordsData = loadKeywords(cwd);

  const targets = (files && files.length)
    ? files
    : [];

  if (targets.length === 0) {
    console.error(chalk.red('seo check: no markdown files given. Pass the PR\'s changed .md files as arguments.'));
    process.exit(2);
  }

  const results = [];
  for (const file of targets) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) {
      results.push({ file, errors: [`File not found: ${file}`], warnings: [] });
      continue;
    }
    const markdown = readFileSync(abs, 'utf8');
    const slug = slugFromPath(file);
    const { parsed } = parseFrontmatter(markdown);
    const keyword = keywordFor(slug, keywordsData, parsed);
    console.log(chalk.bold(`\nChecking ${file} (keyword: "${keyword.keyword}")`));
    const { ok, errors, warnings } = validate(markdown, keyword);
    results.push({ file, ok, errors, warnings });
  }

  const failed = results.filter(r => (r.errors || []).length > 0);
  const report = {
    ok: failed.length === 0,
    checked: results.length,
    failed: failed.length,
    pages: results.map(r => ({ file: r.file, errors: r.errors || [], warnings: r.warnings || [] })),
  };

  // Machine-readable line for CI to parse (prefixed for easy grep)
  console.log('\nSEO_CHECK_JSON=' + JSON.stringify(report));

  if (!report.ok) {
    console.log(chalk.red(`\nseo check FAILED: ${failed.length}/${results.length} page(s) have errors`));
    process.exit(1);
  }
  console.log(chalk.green(`\nseo check PASSED: ${results.length} page(s) clean`));
}
