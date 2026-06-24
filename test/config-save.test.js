import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveConfig, loadConfig } from '../src/lib/config.js';

describe('config-save', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-cfg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes seo.config.yaml that loadConfig reads back', () => {
    const config = {
      project: 'demo', repo: 'o/demo', landing_path: 'resources/landing/de/',
      locales: ['de', 'en'], locale: 'de', weekly_cap: 4, clusters: ['a', 'b'],
    };
    saveConfig(config, dir);
    expect(existsSync(join(dir, 'seo.config.yaml'))).toBe(true);

    const loaded = loadConfig(dir);
    expect(loaded).toMatchObject(config);
  });

  it('round-trips values that survive the DEFAULTS merge', () => {
    saveConfig({ project: 'x', score_cutoff: 9, primary_cta: 'contact' }, dir);
    const loaded = loadConfig(dir);
    expect(loaded.score_cutoff).toBe(9);
    expect(loaded.primary_cta).toBe('contact');
    // unspecified keys fall back to DEFAULTS
    expect(loaded.min_impressions).toBe(5);
  });
});
