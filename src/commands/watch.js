import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { commitState } from '../lib/state.js';
import { writeReport } from '../lib/runlog.js';
import { INDEX_STATUS_FILE } from '../lib/index-status.js';
import { ALERTS_FILE } from '../lib/watch.js';
import { watch } from '../steps/watch.js';

/**
 * `seo watch`: the daily check without an LLM. `--commit` pushes only its own
 * files (alerts and index snapshot), and only when they changed. `--report`
 * writes the result for the workflow's notify step. It writes no run log: the
 * history belongs to the runs that do work.
 */
export async function watchCommand(opts = {}) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  for (const key of ['gsc_property', 'base_url']) {
    if (!config[key]) {
      console.error(chalk.red(`watch: ${key} missing in seo.config.yaml`));
      process.exit(1);
    }
  }
  if (opts.commit && !config.repo) {
    console.error(chalk.red('watch: repo missing in seo.config.yaml, cannot commit'));
    process.exit(1);
  }

  const dryRun = opts.dryRun ?? false;
  const report = await watch({ config, cwd, dryRun });
  report.warnings.forEach(w => console.log(chalk.yellow(`  ${w}`)));
  report.alerts.opened.forEach(a => console.log(chalk.red(`  ALERT ${a.id}: ${a.detail}`)));
  report.alerts.resolved.forEach(a => console.log(chalk.green(`  resolved ${a.id}`)));
  console.log(`  watch: ${report.status}, ${report.open_alerts.length} open alert(s).`);

  if (opts.commit && !dryRun) {
    try {
      const committed = await commitState({ cwd, repo: config.repo, reason: 'watch', files: [ALERTS_FILE, INDEX_STATUS_FILE] });
      console.log(chalk.green(`  state committed to main: ${committed.length ? committed.join(', ') : 'nothing changed'}.`));
    } catch (e) {
      report.warnings.push(`State commit failed: ${e.message}`);
      console.error(chalk.red(`  watch commit failed (non-fatal): ${e.message}`));
    }
  }
  if (opts.report) writeReport(opts.report, report);
}
