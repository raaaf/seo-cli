import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { fetchSitemapUrls, submitIndexNow } from '../lib/indexnow.js';

export async function indexnowCommand() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (!config.base_url) {
    console.error(chalk.red('indexnow: base_url missing in seo.config.yaml'));
    process.exit(1);
  }
  if (!config.indexnow_key) {
    console.error(chalk.red('indexnow: indexnow_key missing in seo.config.yaml'));
    process.exit(1);
  }

  const urls = await fetchSitemapUrls(config.base_url);
  if (urls.length === 0) {
    console.log(chalk.yellow('indexnow: sitemap has no URLs'));
    process.exit(1);
  }

  const host = new URL(config.base_url).host;
  console.log(chalk.blue(`Submitting ${urls.length} URL(s) to IndexNow for ${host} ...`));

  try {
    const { status } = await submitIndexNow({ baseUrl: config.base_url, key: config.indexnow_key, urls });
    console.log(chalk.green(`IndexNow accepted (${status}).`));
  } catch (e) {
    console.error(chalk.red(`IndexNow submit failed: ${e.message}`));
    process.exit(1);
  }
}
