import { readFileSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import chalk from 'chalk';
import { loadKeywords } from '../lib/keywords.js';
import { validate } from '../steps/validate.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { loadConfig, isStrict, defaultLocale, CONFIG_FILE } from '../lib/config.js';
import { strictValidateOpts } from '../lib/landings.js';
import { loadCatalog, contractOptions } from '../lib/catalog.js';
import { overlayKeyOfFile, parseOverlay, validateOverlay } from '../steps/overlay.js';

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

// `quality: strict` in the project's config, or --strict. A project without a config file is standard.
function wantsStrict(cwd, flag) {
  if (flag) return true;
  try {
    return isStrict(loadConfig(cwd));
  } catch {
    return false;
  }
}

export async function checkCommand(files, opts = {}) {
  const cwd = process.cwd();
  const strict = wantsStrict(cwd, opts.strict);
  const keywordsData = loadKeywords(cwd);

  const targets = (files && files.length)
    ? files
    : [];

  if (targets.length === 0) {
    console.error(chalk.red('seo check: no markdown files given. Pass the PR\'s changed .md files as arguments.'));
    process.exit(2);
  }

  // Projects with a page contract or overlays keep their rules in seo.config.yaml; others have no config here.
  const config = existsSync(join(cwd, CONFIG_FILE)) ? loadConfig(cwd) : null;
  let catalog = null;
  if (config?.catalog_url) {
    try {
      catalog = await loadCatalog(config);
    } catch (e) {
      console.error(chalk.red(`seo check: ${e.message}`));
      process.exit(1);
    }
  }
  const validateOpts = config ? contractOptions(config, catalog, cwd, defaultLocale(config)) : {};

  const results = [];
  for (const file of targets) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) {
      results.push({ file, errors: [`File not found: ${file}`], warnings: [] });
      continue;
    }
    const markdown = readFileSync(abs, 'utf8');
    const overlay = config?.overlays ? overlayKeyOfFile(config, file) : null;
    if (overlay) {
      console.log(chalk.bold(`\nChecking ${file} (overlay ${overlay})`));
      const { fields, error } = parseOverlay(markdown);
      const { errors, warnings } = error
        ? { errors: [error], warnings: [] }
        : validateOverlay(fields, { key: overlay, contract: config.page_contract, catalog });
      errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
      warnings.forEach(w => console.log(chalk.yellow(`    ⚠ ${w}`)));
      results.push({ file, ok: errors.length === 0, errors, warnings });
      continue;
    }
    const slug = slugFromPath(file);
    const { parsed } = parseFrontmatter(markdown);
    const keyword = keywordFor(slug, keywordsData, parsed);
    console.log(chalk.bold(`\nChecking ${file} (keyword: "${keyword.keyword}")`));
    const { ok, errors, warnings } = validate(markdown, keyword, { ...strictValidateOpts({}, dirname(abs), [slug], strict), ...validateOpts });
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
