import chalk from 'chalk';
import { discoverProjects } from '../lib/projects.js';
import { projectSummary } from '../lib/dashboard.js';
import { isoWeek } from '../lib/date.js';

const STATUS_LABEL = {
  proposed: 'todo',
  pr_opened: 'in-PR',
  done: 'done',
  validation_failed: 'failed',
  skip: 'skip',
};
const STATUS_ORDER = ['proposed', 'pr_opened', 'done', 'validation_failed', 'skip'];

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function funnelLine(counts) {
  return STATUS_ORDER
    .filter(s => counts[s])
    .map(s => `${counts[s]} ${STATUS_LABEL[s]}`)
    .join(chalk.dim(' · '));
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function renderProject(summary) {
  const { project, updated, total, counts, backlog, rank, suggestions, liveError } = summary;
  const lines = [];

  lines.push(
    chalk.bold.cyan(project.dir) +
    chalk.dim(`  (${project.name})`) +
    chalk.dim(`   keywords updated ${updated || 'never'}`)
  );

  lines.push('  ' + pad(chalk.dim('Funnel'), 18) + funnelLine(counts) + chalk.dim(`  (${total} total)`));

  const backlogText = backlog.length
    ? `${backlog.length} keyword(s) ready` + chalk.dim(` ≥ score ${project.config.score_cutoff ?? 7}`)
    : chalk.dim('empty');
  lines.push('  ' + pad(chalk.dim('Backlog'), 18) + backlogText);

  if (rank && rank.rows && rank.rows.length) {
    const tag = rank.live ? chalk.green('live') : chalk.dim(`snapshot ${rank.snapshotDate}`);
    lines.push(
      '  ' + pad(chalk.dim('Rankings'), 18) +
      `Ø pos ${rank.avgPos.toFixed(1)}` +
      chalk.dim(' · ') + `${rank.impressions} impr` +
      chalk.dim(' · ') + `${rank.clicks} clicks` +
      chalk.dim(' · ') + `CTR ${pct(rank.ctr)}` +
      `   ${tag}`
    );
    const up = (rank.movers || []).filter(m => m.delta > 0).slice(0, 2);
    const down = (rank.movers || []).filter(m => m.delta < 0).slice(0, 1);
    const moverStr = [
      ...up.map(m => chalk.green('▲ ') + `${m.query} ${m.from.toFixed(0)}→${m.to.toFixed(0)}`),
      ...down.map(m => chalk.red('▼ ') + `${m.query} ${m.from.toFixed(0)}→${m.to.toFixed(0)}`),
    ];
    if (moverStr.length) lines.push('  ' + pad(chalk.dim('Movers'), 18) + moverStr.join(chalk.dim('   ')));
  } else {
    lines.push('  ' + pad(chalk.dim('Rankings'), 18) + chalk.dim('no ranking data yet'));
  }

  if (liveError) lines.push('  ' + pad(chalk.dim('Live'), 18) + chalk.yellow(`GSC pull failed: ${liveError}`));

  if (suggestions.length) {
    lines.push('  ' + chalk.dim('Next'));
    for (const s of suggestions) lines.push('    ' + chalk.yellow('→ ') + s.text);
  }

  return lines.join('\n');
}

function renderOverview(summaries, week) {
  const head =
    pad('PROJECT', 16) + pad('TODO', 6) + pad('IN-PR', 7) + pad('DONE', 6) + pad('Ø POS', 8) + pad('CLICKS', 8);
  const rows = summaries.map(s => {
    const c = s.counts;
    const avg = s.rank && s.rank.avgPos != null ? s.rank.avgPos.toFixed(1) : '—';
    const clicks = s.rank && s.rank.rows ? String(s.rank.clicks) : '—';
    return pad(s.project.dir, 16) +
      pad(c.proposed || 0, 6) +
      pad(c.pr_opened || 0, 7) +
      pad(c.done || 0, 6) +
      pad(avg, 8) +
      pad(clicks, 8);
  });
  return [
    chalk.bold('SEO OVERVIEW') + chalk.dim(`   ${week}`),
    chalk.dim(head),
    ...rows,
  ].join('\n');
}

export async function dashboardCommand(opts = {}) {
  const projects = discoverProjects();
  const filtered = opts.project
    ? projects.filter(p => p.dir.includes(opts.project) || p.name.includes(opts.project))
    : projects;

  if (filtered.length === 0) {
    console.error(chalk.red('No SEO projects found.') + chalk.dim(' Set SEO_PROJECT_ROOTS or run "seo init" in a project.'));
    process.exit(1);
  }

  if (opts.live) console.error(chalk.dim('Pulling live GSC data…'));
  const summaries = await Promise.all(filtered.map(p => projectSummary(p, { live: !!opts.live })));

  if (opts.json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  const week = isoWeek();
  console.log('\n' + renderOverview(summaries, week) + '\n');
  console.log(summaries.map(renderProject).join('\n\n'));
  console.log('');
}
