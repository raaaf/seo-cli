import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/lib/claude.js', () => ({ getLlmStats: () => ({ fallbacks: [], usd_equivalent: 0 }) }));

const { writeRunLog } = await import('../src/lib/runlog.js');

let dir;
const lines = () => readFileSync(join(dir, 'seo/runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const report = (over = {}) => ({ status: 'prs_opened', prs: [{ url: 'u', kind: 'new', slug: 's' }], budget: null, llm: null, warnings: ['w'], errors: [], ...over });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-runlog-')); mkdirSync(join(dir, 'seo')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runlog', () => {
  it('writes last-run.json without the changed lists and one summary line', () => {
    const r = report({ measurement: { entries: 3, changed: [{ slug: 'a' }] } });
    writeRunLog({ cwd: dir, report: r, mode: 'run', today: '2026-10-07' });

    const last = JSON.parse(readFileSync(join(dir, 'seo/last-run.json'), 'utf8'));
    expect(last).toMatchObject({ date: '2026-10-07', mode: 'run', status: 'prs_opened', measurement: { entries: 3 } });
    expect(last.measurement.changed).toBeUndefined();
    expect(lines()).toEqual([{ date: '2026-10-07', mode: 'run', status: 'prs_opened', prs: r.prs, llm: null, budget: null, warnings: 1, errors: 0 }]);
  });

  it('keeps only the last 52 lines', () => {
    for (let i = 0; i < 55; i++) writeRunLog({ cwd: dir, report: report(), mode: 'run', today: `d${i}` });
    const all = lines();
    expect(all).toHaveLength(52);
    expect(all[0].date).toBe('d3');
    expect(all.at(-1).date).toBe('d54');
  });

  it('drops an unreadable line with a warning and carries on', () => {
    writeFileSync(join(dir, 'seo/runs.jsonl'), '{"date":"ok"}\nnot json\n');
    const r = report({ warnings: [] });
    writeRunLog({ cwd: dir, report: r, mode: 'improve', today: 'd' });

    expect(lines().map(l => l.date)).toEqual(['ok', 'd']);
    expect(r.warnings[0]).toMatch(/unreadable line/);
  });
});
