import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'seo.js');

function run(args) {
  return execFileSync('node', [bin, ...args], { encoding: 'utf8' });
}

describe('cli-entry', () => {
  it('lists every subcommand in --help and exits 0', () => {
    const out = run(['--help']);
    for (const cmd of ['init', 'run', 'check', 'dashboard', 'submit-sitemap']) {
      expect(out).toContain(cmd);
    }
  });

  it('reports the package version', () => {
    expect(run(['--version']).trim()).toBe('0.1.0');
  });
});
