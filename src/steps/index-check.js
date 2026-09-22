import chalk from 'chalk';
import { fetchSitemapUrls } from '../lib/indexnow.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { fetchIndexStatus, loadIndexStatus, saveIndexStatus, diffIndexStatus } from '../lib/index-status.js';

// The Inspection API's daily quota is shared across the whole property, not just
// this command — a site with a large sitemap must not spend it all on one run.
const MAX_URLS = 50;

/**
 * Fetches live index status for the site's sitemap URLs, diffs it against last
 * week's snapshot, prints a summary, and returns `{ current, diff, changed }`
 * for the caller to persist and commit. `changed` is false when the diff is
 * empty and nothing new needs to be written (still true on baseline, since the
 * first snapshot is itself new information).
 */
export async function checkIndexStatus(config, cwd = process.cwd()) {
  const urls = await fetchSitemapUrls(config.base_url, safeFetch);
  const truncated = urls.length > MAX_URLS;
  const inspectUrls = urls.slice(0, MAX_URLS);
  if (truncated) {
    console.log(chalk.yellow(`  Sitemap has ${urls.length} URLs — capping index-status inspection at ${MAX_URLS}.`));
  }

  const current = await fetchIndexStatus(config, inspectUrls);
  const previous = loadIndexStatus(cwd);
  const diff = diffIndexStatus(previous, current);

  printSummary(diff, previous);

  const data = { version: 1, updated: previous.updated, entries: current };
  saveIndexStatus(data, cwd);

  return { current, diff };
}

function printSummary(diff, previous) {
  const isBaseline = !previous?.entries?.length;
  if (isBaseline) {
    console.log(chalk.blue(`  Baseline snapshot: ${diff.unchanged} URL(s) recorded, nothing to compare against yet.`));
    return;
  }

  console.log(
    `  Index status: ${diff.unchanged} unchanged, ${diff.newlyIndexed.length} newly indexed, ` +
    `${diff.newlyDropped.length} newly dropped, ${diff.stillMissing.length} still missing.`
  );
  for (const url of diff.newlyDropped) {
    console.log(chalk.red(`  ✗ dropped from index: ${url}`));
  }
  for (const url of diff.newlyIndexed) {
    console.log(chalk.green(`  ✓ newly indexed: ${url}`));
  }
}
