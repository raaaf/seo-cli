import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
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

export async function track(config, cwd = process.cwd()) {
  console.log(chalk.blue('Tracking rankings...'));

  const rows = await queryPagePerformance(config.gsc_property);

  const week = isoWeek();
  const csvPath = join(cwd, `seo/rankings/${week}.csv`);
  mkdirSync(join(cwd, 'seo/rankings'), { recursive: true });

  const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB soft cap
  const sizeBytes = existsSync(csvPath) ? statSync(csvPath).size : 0;
  if (sizeBytes > MAX_CSV_BYTES) {
    console.log(chalk.yellow(`  Track skipped: ${csvPath} exceeds ${MAX_CSV_BYTES} bytes. Rotate (rename) the file to start a fresh week.`));
    return;
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
