import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProjects } from '../src/lib/projects.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'seo-roots-')); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SEO_PROJECT_ROOTS;
});

function project(rel, yamlBody) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'seo.config.yaml'), yamlBody, 'utf8');
}

describe('projects-discover', () => {
  it('finds projects, skips ignored/unparseable, dedupes and sorts by dir', () => {
    project('beta', 'project: Beta Site\n');
    project('alpha', 'project: Alpha Site\n');
    project('node_modules/dep', 'project: should-be-ignored\n');
    project('broken', 'project: [unterminated\n');

    process.env.SEO_PROJECT_ROOTS = root;
    const found = discoverProjects();

    expect(found.map(p => p.dir)).toEqual(['alpha', 'beta']);
    expect(found[0].name).toBe('Alpha Site');
    expect(found.find(p => p.dir === 'dep')).toBeUndefined();
    expect(found.find(p => p.dir === 'broken')).toBeUndefined();
  });

  it('finds a project nested below the root', () => {
    project('clients/acme', 'project: Acme\n');
    process.env.SEO_PROJECT_ROOTS = root;
    const found = discoverProjects();
    expect(found.map(p => p.name)).toContain('Acme');
  });

  it('returns an empty list when no roots exist', () => {
    process.env.SEO_PROJECT_ROOTS = join(root, 'nope');
    expect(discoverProjects()).toEqual([]);
  });
});
