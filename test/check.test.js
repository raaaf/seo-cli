import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkCommand } from '../src/commands/check.js';
import { makeValidPage } from './helpers/valid-page.js';

const validDoc = () => makeValidPage();

let dir, cwd, logs, exitSpy;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-check-'));
  cwd = process.cwd();
  process.chdir(dir);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function checkJson() {
  const line = logs.find(l => l.includes('SEO_CHECK_JSON='));
  return JSON.parse(line.slice(line.indexOf('SEO_CHECK_JSON=') + 'SEO_CHECK_JSON='.length));
}

describe('check-cmd', () => {
  it('exits 2 when no files are given', async () => {
    await expect(checkCommand([])).rejects.toThrow('exit:2');
  });

  it('passes a clean page and emits SEO_CHECK_JSON ok:true', async () => {
    writeFileSync(join(dir, 'webdesign-berlin.md'), validDoc(), 'utf8');
    await checkCommand(['webdesign-berlin.md']);
    const report = checkJson();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports a missing file and exits 1', async () => {
    await expect(checkCommand(['nope.md'])).rejects.toThrow('exit:1');
    const report = checkJson();
    expect(report.ok).toBe(false);
    expect(report.pages[0].errors[0]).toMatch(/File not found/);
  });
});
