import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { submitSitemap } from '../lib/gsc.js';

export async function submitSitemapCommand() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (!config.gsc_property) {
    console.error(chalk.red('submit-sitemap: gsc_property missing in seo.config.yaml'));
    process.exit(1);
  }
  if (!config.base_url) {
    console.error(chalk.red('submit-sitemap: base_url missing in seo.config.yaml'));
    process.exit(1);
  }

  const sitemapUrl = `${config.base_url.replace(/\/$/, '')}/sitemap.xml`;
  console.log(chalk.blue(`Submitting ${sitemapUrl} to ${config.gsc_property} ...`));

  try {
    await submitSitemap(config.gsc_property, sitemapUrl);
    console.log(chalk.green('Sitemap submitted.'));
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 403) {
      console.error(chalk.red(
        'Sitemap submit failed (403). The GSC auth account needs owner/full access ' +
        'to the property AND the write scope (https://www.googleapis.com/auth/webmasters). ' +
        'A readonly OAuth token will not work — re-mint it with the write scope.'
      ));
    } else {
      console.error(chalk.red(`Sitemap submit failed: ${e.message}`));
    }
    process.exit(1);
  }
}
