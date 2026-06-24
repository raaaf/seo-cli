import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from '../src/commands/run.js';

const REQUIRED = ['ANTHROPIC_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SERPAPI_KEY', 'GITHUB_TOKEN'];

let saved, logs;
beforeEach(() => {
  saved = {};
  for (const k of REQUIRED) { saved[k] = process.env[k]; delete process.env[k]; }
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  for (const k of REQUIRED) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe('run-env', () => {
  it('exits 1 and lists every missing required env var', async () => {
    await expect(runCommand({})).rejects.toThrow('exit:1');
    const out = logs.join('\n');
    for (const k of REQUIRED) expect(out).toContain(k);
  });

  it('lists only the env vars that are actually missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.GITHUB_TOKEN = 'y';
    await expect(runCommand({})).rejects.toThrow('exit:1');
    const out = logs.join('\n');
    expect(out).toContain('SERPAPI_KEY');
    expect(out).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(out).not.toContain('ANTHROPIC_API_KEY');
    expect(out).not.toContain('GITHUB_TOKEN');
  });
});
