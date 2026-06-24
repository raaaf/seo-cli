import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { queryPagePerformance } from '../lib/gsc.js';
import { isoWeek, format } from '../lib/date.js';

const CSV_HEADER = 'date,url,query,position,impressions,clicks,ctr';

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Merge today's snapshot into the existing CSV idempotently: drop any prior
// rows for `today` (a same-day re-run replaces them) and keep all other days.
// `today` is YYYY-MM-DD, which never appears quoted, so prefix-matching the
// first column is safe.
export function mergeRankingCsv(existing, today, newLines) {
  const kept = (existing || '')
    .split('\n')
    .filter(l => l && l !== CSV_HEADER && !l.startsWith(`${today},`));
  return [CSV_HEADER, ...kept, ...newLines].join('\n') + '\n';
}

// Next free `<week>-partN.csv` archive name when rotating an oversized CSV.
function nextArchiveName(cwd, week) {
  let n = 1;
  while (existsSync(join(cwd, `seo/rankings/${week}-part${n}.csv`))) n++;
  return `${week}-part${n}.csv`;
}

export async function track(config, cwd = process.cwd()) {
  console.log(chalk.blue('Tracking rankings...'));

  const rows = await queryPagePerformance(config.gsc_property);

  const week = isoWeek();
  const csvPath = join(cwd, `seo/rankings/${week}.csv`);
  mkdirSync(join(cwd, 'seo/rankings'), { recursive: true });

  const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB soft cap
  const sizeBytes = existsSync(csvPath) ? statSync(csvPath).size : 0;
  if (sizeBytes > MAX_CSV_BYTES) {
    // Auto-rotate instead of silently skipping: archive the full file to a
    // `<week>-partN.csv` sibling (still picked up by the dashboard's CSV scan)
    // and start a fresh `<week>.csv`.
    const archived = nextArchiveName(cwd, week);
    renameSync(csvPath, join(cwd, `seo/rankings/${archived}`));
    console.log(chalk.yellow(`  Rankings CSV exceeded ${MAX_CSV_BYTES} bytes — rotated to ${archived}, starting a fresh ${week}.csv.`));
  }

  const today = format(new Date());
  const lines = rows.map(r => {
    const url = r.keys[0];
    const query = r.keys[1];
    return `${today},${csvCell(url)},${csvCell(query)},${r.position.toFixed(1)},${r.impressions},${r.clicks},${r.ctr.toFixed(4)}`;
  });

  const existing = existsSync(csvPath) ? readFileSync(csvPath, 'utf8') : '';
  writeFileSync(csvPath, mergeRankingCsv(existing, today, lines), 'utf8');

  console.log(chalk.green(`  Track done. ${lines.length} rows written to seo/rankings/${week}.csv`));
}
