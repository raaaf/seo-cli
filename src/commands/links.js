import chalk from 'chalk';
import { loadConfig, defaultLocale } from '../lib/config.js';
import { readLandingPages, buildInboundLinkFiles } from '../lib/landings.js';
import { inboundLinks } from '../lib/inbound-links.js';
import { createBranchAndCommit, openPR, deleteBranch } from '../lib/github.js';
import { isoWeek } from '../lib/date.js';

const MIN_INBOUND_LINKS = 3;

// Every page of the locale with fewer than three inbound links gets `related_pages` entries on
// on-topic pages. Returns `{ files, rows }`, rows being `{ locale, source, target, before, after }`.
function planLocale(config, cwd, locale) {
  const pages = readLandingPages(config, cwd, locale);
  const inbound = inboundLinks(pages);
  const needy = pages
    .map(p => ({ ...p, count: inbound.get(p.slug).size }))
    .filter(p => p.count < MIN_INBOUND_LINKS)
    .sort((a, b) => a.count - b.count || a.slug.localeCompare(b.slug));
  const targets = needy.map(p => ({ slug: p.slug, text: `${p.title} ${p.slug}`, max: MIN_INBOUND_LINKS - p.count }));
  const { files, links } = buildInboundLinkFiles({ targets, config, cwd, locale });
  const before = new Map(needy.map(p => [p.slug, p.count]));
  const rows = links.map(l => ({
    locale, ...l,
    before: before.get(l.target),
    after: before.get(l.target) + links.filter(x => x.target === l.target).length,
  }));
  return { files, rows };
}

const rowLine = (r) => `- \`${r.source}\` -> \`${r.target}\` (${r.locale}, inbound ${r.before} -> ${r.after})`;

/**
 * `seo links`: one PR (`seo/links/<week>`) that gives every landing page with fewer than three
 * inbound links up to three, as `related_pages` entries on on-topic pages. No LLM. `--dry-run`
 * prints the plan and writes nothing. Returns the PR url, or null when there was nothing to do,
 * on a dry run or when the branch already exists.
 */
export async function linksCommand(opts = {}, cwd = process.cwd()) {
  const config = opts.config ?? loadConfig(cwd);
  const def = defaultLocale(config);
  const locales = [def, ...(config.counterpart_locale && config.counterpart_locale !== def ? [config.counterpart_locale] : [])];

  console.log(chalk.bold(`\nseo links: ${config.project}${opts.dryRun ? ' (dry run)' : ''}\n`));

  const plans = locales.map(locale => planLocale(config, cwd, locale));
  const files = plans.flatMap(p => p.files);
  const rows = plans.flatMap(p => p.rows);
  if (!rows.length) {
    console.log(chalk.gray('  Nothing to do: every page has enough inbound links or no on-topic page has room left.'));
    return null;
  }

  const lines = rows.map(rowLine);
  console.log(lines.join('\n'));
  if (opts.dryRun) return null;

  const week = isoWeek();
  const branch = `seo/links/${week}`;
  try {
    await createBranchAndCommit({ files, message: `seo: internal links (${week})`, cwd, repo: config.repo, branch });
  } catch (e) {
    if (e.code !== 'BRANCH_EXISTS') throw e;
    console.log(chalk.yellow(`  Links skipped: branch ${branch} already exists (an earlier PR is still open)`));
    return null;
  }

  let url;
  try {
    url = await openPR({
      repo: config.repo,
      branch,
      title: `SEO: internal links (${week})`,
      body: `## Internal links\n\nEach source page lists the target in \`related_pages\`. Inbound counts are links from other pages of the same locale.\n\n${lines.join('\n')}`,
    });
  } catch (e) {
    // Without a PR the branch is an orphan that would block this week for good.
    await deleteBranch({ repo: config.repo, branch }).catch(err => console.log(chalk.yellow(`  Could not delete orphan branch ${branch}: ${err.message}`)));
    throw e;
  }
  console.log(chalk.green(`  PR opened: ${url}`));
  return url;
}
