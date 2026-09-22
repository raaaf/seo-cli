import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { createBranchAndCommit } from '../lib/github.js';
import { checkIndexStatus } from '../steps/index-check.js';
import { INDEX_STATUS_FILE, loadIndexStatus } from '../lib/index-status.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `--commit` pushes `seo/index-status.json` straight to `main` via the same
 * GitHub API commit path `seo run` and `seo improve` use for their state
 * files — no PR, since this is a bookkeeping snapshot, not content to review.
 * Off by default so a local/manual run (e.g. to sanity-check a property) never
 * writes to the target repo by surprise.
 */
export async function indexStatusCommand(opts = {}) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (!config.gsc_property) {
    console.error(chalk.red('index-status: gsc_property missing in seo.config.yaml'));
    process.exit(1);
  }
  if (!config.base_url) {
    console.error(chalk.red('index-status: base_url missing in seo.config.yaml'));
    process.exit(1);
  }

  const { current, diff } = await checkIndexStatus(config, cwd);

  if (opts.json) {
    console.log(JSON.stringify({ entries: current, diff }, null, 2));
  }

  if (opts.commit) {
    if (!config.repo) {
      console.error(chalk.red('index-status: repo missing in seo.config.yaml, cannot commit'));
      process.exit(1);
    }
    try {
      const content = readFileSync(join(cwd, INDEX_STATUS_FILE), 'utf8');
      const week = loadIndexStatus(cwd).updated;
      await createBranchAndCommit({
        files: [{ path: INDEX_STATUS_FILE, content }],
        message: `seo: weekly index-status snapshot (${week})`,
        cwd,
        repo: config.repo,
        branch: 'main',
        baseBranch: 'main',
      });
      console.log(chalk.green('  seo/index-status.json committed to main.'));
    } catch (e) {
      console.error(chalk.red(`  index-status commit failed (non-fatal): ${e.message}`));
    }
  }
}
