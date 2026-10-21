import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { fetchLive, isLive, expectedLive } from '../steps/watch.js';

const POLL_MS = 30_000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A target is a URL, or a changed file of a PR that is mapped to the URL it should serve.
function liveTargets(config, targets, headRef) {
  const urls = targets.filter(t => /^https?:\/\//.test(t)).map(url => ({ key: url, url }));
  const files = targets.filter(t => !/^https?:\/\//.test(t));
  return [...urls, ...expectedLive({ headRef: headRef ?? '', files }, config)];
}

/**
 * Polls until every target answers like a deployed page (the same check the
 * watcher's `not_deployed` alert uses), at most `wait` minutes. Returns true
 * when all are live. A project without `watch.check_deploy` has no deploy lag
 * to wait for and passes at once.
 */
export async function waitUntilLive(config, targets, { headRef, wait = 0, cwd = process.cwd(), fetchPage = fetchLive, pause = sleep } = {}) {
  if (!config.watch?.check_deploy) return true;
  const pending = liveTargets(config, targets, headRef);
  const deadline = Date.now() + wait * 60_000;
  for (;;) {
    for (const t of [...pending]) {
      let live = null;
      try {
        live = await isLive({ slug: t.key, urls: [t.url] }, { config, cwd, fetchPage });
      } catch {
        // a failed fetch decides nothing, the next round asks again
      }
      if (live === true) pending.splice(pending.indexOf(t), 1);
    }
    if (pending.length === 0) return true;
    if (Date.now() >= deadline) {
      console.log(chalk.yellow(`Not live yet: ${pending.map(t => t.url).join(', ')}`));
      return false;
    }
    await pause(POLL_MS);
  }
}

export async function liveCheckCommand(targets, opts = {}) {
  const live = await waitUntilLive(loadConfig(), targets, { headRef: opts.headRef, wait: Number(opts.wait) || 0 });
  if (!live) process.exit(1);
  console.log(chalk.green('live (or no deploy check configured)'));
}
