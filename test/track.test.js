import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const queryPagePerformance = vi.fn();
vi.mock('../src/lib/gsc.js', () => ({ queryPagePerformance: (...a) => queryPagePerformance(...a) }));

const { mergeRankingCsv, track } = await import('../src/steps/track.js');
const { isoWeek, format } = await import('../src/lib/date.js');

const HEADER = 'date,url,query,position,impressions,clicks,ctr';

describe('track-merge: mergeRankingCsv', () => {
  it('keeps the header, drops prior same-day rows and preserves other days', () => {
    const existing = `${HEADER}\n2026-05-01,u,q,5.0,1,0,0\n2026-06-01,u,q,9.0,2,0,0`;
    const merged = mergeRankingCsv(existing, '2026-06-01', ['2026-06-01,u,q,4.0,3,1,0.33']);
    const lines = merged.trim().split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toContain('2026-05-01,u,q,5.0,1,0,0');
    expect(lines).toContain('2026-06-01,u,q,4.0,3,1,0.33');
    expect(lines.filter(l => l.startsWith('2026-06-01,'))).toHaveLength(1);
  });

  it('starts from just the header when there is no existing file', () => {
    const merged = mergeRankingCsv('', '2026-06-01', ['2026-06-01,u,q,4.0,3,1,0.33']);
    expect(merged).toBe(`${HEADER}\n2026-06-01,u,q,4.0,3,1,0.33\n`);
  });
});

describe('track-run: track', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-track-')); queryPagePerformance.mockReset(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes the GSC snapshot to the weekly CSV', async () => {
    queryPagePerformance.mockResolvedValue([
      { keys: ['https://s/a', 'query1'], position: 5.04, impressions: 120, clicks: 10, ctr: 0.0833 },
    ]);
    await track({ gsc_property: 'sc-domain:x' }, dir);

    const csvPath = join(dir, `seo/rankings/${isoWeek()}.csv`);
    expect(existsSync(csvPath)).toBe(true);
    const content = readFileSync(csvPath, 'utf8');
    expect(content.startsWith(HEADER)).toBe(true);
    expect(content).toContain(`${format(new Date())},https://s/a,query1,5.0,120,10,0.0833`);
  });

  it('rotates an oversized CSV to a -part archive, then writes a fresh weekly CSV', async () => {
    queryPagePerformance.mockResolvedValue([
      { keys: ['https://s/a', 'q'], position: 1.0, impressions: 1, clicks: 0, ctr: 0 },
    ]);
    const week = isoWeek();
    const csvPath = join(dir, `seo/rankings/${week}.csv`);
    const archivePath = join(dir, `seo/rankings/${week}-part1.csv`);
    mkdirSync(join(dir, 'seo/rankings'), { recursive: true });
    writeFileSync(csvPath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8');

    await track({ gsc_property: 'sc-domain:x' }, dir);

    // old oversized content archived, not lost
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, 'utf8').startsWith('xxxx')).toBe(true);
    // fresh weekly CSV with header + today's snapshot
    const fresh = readFileSync(csvPath, 'utf8');
    expect(fresh.startsWith(HEADER)).toBe(true);
    expect(fresh).toContain(`${format(new Date())},https://s/a,q,1.0,1,0,0.0000`);
  });
});
