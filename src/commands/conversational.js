import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { queryPagePerformance } from '../lib/gsc.js';
import { groupConversational, BUCKETS } from '../lib/conversational.js';

const DEFAULT_DAYS = 90;
const TOP_ROWS = 10;

const BUCKET_LABEL = {
  artefact: 'Artefacts (AI Mode replies logged as queries)',
  tracker_probe: 'Tracker probes (AI-visibility tools)',
  conversational: 'Conversational (real questions, unphrased as keywords)',
  keyword: 'Keyword (ordinary search, not reported)',
};

/** GSC rows for the project in the shape groupConversational expects. */
async function fetchQueryRows(config, days) {
  const rows = await queryPagePerformance(config.gsc_property, { days, pageFilter: config.base_url || null });
  return rows.map(r => ({
    query: r.keys[1],
    page: r.keys[0],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
  }));
}

function renderRow(row) {
  return `    i${String(row.impressions).padStart(4)}  p${row.position.toFixed(1).padStart(4)}  "${row.query}"  -> ${row.page}`;
}

function renderBucket(bucket, rows, totals) {
  const lines = [chalk.bold(`${BUCKET_LABEL[bucket]}: ${totals.count} queries, ${totals.impressions} impressions`)];
  if (bucket === 'conversational' && rows.length) {
    lines.push(chalk.dim('  Sorted by impressions: a real question with impressions and a bad position is a content gap nobody phrased as a keyword.'));
  }
  for (const row of rows.slice(0, TOP_ROWS)) lines.push(renderRow(row));
  return lines.join('\n');
}

export async function conversationalCommand(opts = {}) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const days = Number(opts.days) || DEFAULT_DAYS;

  if (!config.gsc_property) {
    console.error(chalk.red('conversational: gsc_property missing in seo.config.yaml'));
    process.exit(1);
  }

  const rows = await fetchQueryRows(config, days);
  const grouped = groupConversational(rows);

  if (opts.json) {
    console.log(JSON.stringify(grouped, null, 2));
    return grouped;
  }

  console.log(chalk.bold(`\nseo conversational — ${config.project} (last ${days} days)\n`));
  for (const bucket of BUCKETS) {
    if (bucket === 'keyword') continue; // ordinary search behaviour, not reported
    console.log(renderBucket(bucket, grouped[bucket], grouped.totals[bucket]));
    console.log('');
  }

  return grouped;
}
