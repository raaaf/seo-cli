import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { projectSummary } from '../src/lib/dashboard.js';

let path;
beforeEach(() => { path = mkdtempSync(join(tmpdir(), 'seo-dash-')); });
afterEach(() => { rmSync(path, { recursive: true, force: true }); });

function seedKeywords(keywords) {
  mkdirSync(join(path, 'seo'), { recursive: true });
  writeFileSync(join(path, 'seo/keywords.json'),
    JSON.stringify({ version: 1, updated: '2026-06-01', keywords }), 'utf8');
}

function seedRankings(csv) {
  mkdirSync(join(path, 'seo/rankings'), { recursive: true });
  writeFileSync(join(path, 'seo/rankings/2026-W22.csv'), csv, 'utf8');
}

describe('dashboard-summary', () => {
  it('aggregates funnel counts, backlog, ranking snapshot, movers and suggestions', async () => {
    seedKeywords([
      { keyword: 'k1', status: 'proposed', score: 9 },
      { keyword: 'k2', status: 'proposed', score: 5 },
      { keyword: 'k3', status: 'done', score: 10 },
      { keyword: 'k4', status: 'validation_failed', score: 8 },
    ]);
    seedRankings(
      'date,url,query,position,impressions,clicks,ctr\n' +
      '2026-05-01,https://s/a,query1,12.0,100,0,0\n' +
      '2026-06-01,https://s/a,query1,5.0,120,10,0.0833\n' +
      '2026-06-01,https://s/b,query2,9.0,50,0,0\n'
    );

    const project = { path, dir: 'demo', name: 'Demo', config: { score_cutoff: 7 } };
    const summary = await projectSummary(project, { live: false });

    expect(summary.total).toBe(4);
    expect(summary.counts.proposed).toBe(2);
    expect(summary.counts.done).toBe(1);
    expect(summary.backlog.map(k => k.keyword)).toEqual(['k1']);

    expect(summary.rank.avgPos).toBe(7);
    expect(summary.rank.impressions).toBe(170);
    expect(summary.rank.clicks).toBe(10);
    expect(summary.rank.movers[0]).toMatchObject({ query: 'query1', from: 12, to: 5, delta: 7 });

    const kinds = summary.suggestions.map(s => s.kind);
    expect(kinds).toContain('near_page1');
    expect(kinds).toContain('zero_click');
    expect(kinds).toContain('validation_failed');
  });

  it('suggests discovery when the backlog is empty', async () => {
    seedKeywords([{ keyword: 'k1', status: 'done', score: 10 }]);
    const project = { path, dir: 'demo', name: 'Demo', config: { score_cutoff: 7 } };
    const summary = await projectSummary(project, { live: false });
    expect(summary.backlog).toEqual([]);
    expect(summary.suggestions.map(s => s.kind)).toContain('empty_backlog');
    expect(summary.rank).toBe(null);
  });
});

describe('live snapshot filtering', () => {
  it('drops rows from other subdomains of a domain property', async () => {
    seedKeywords([]);
    vi.doMock('../src/lib/gsc.js', () => ({
      queryPagePerformance: async () => [
        { keys: ['https://rafaelalex.de/preise', 'webdesign preise'], position: 11, impressions: 100, clicks: 0, ctr: 0 },
        { keys: ['https://events.rafaelalex.de/sommerfest', 'sommerfest'], position: 12, impressions: 900, clicks: 0, ctr: 0 },
      ],
    }));
    const { projectSummary: summary } = await import('../src/lib/dashboard.js?live-filter');

    const result = await summary(
      { path, config: { gsc_property: 'sc-domain:rafaelalex.de', base_url: 'https://rafaelalex.de' } },
      { live: true },
    );

    expect(result.rank.rows).toHaveLength(1);
    expect(result.rank.impressions).toBe(100);
  });
});
