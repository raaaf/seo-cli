import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { defaultLocale, localeLandingPath, loadConfig, DEFAULTS } from '../src/lib/config.js';

describe('config-locale: defaultLocale', () => {
  it('returns first entry from locales array', () => {
    expect(defaultLocale({ locales: ['en', 'de'] })).toBe('en');
  });

  it('returns locale when only locale is set', () => {
    expect(defaultLocale({ locale: 'fr' })).toBe('fr');
  });

  it('returns de when neither locales nor locale is set', () => {
    expect(defaultLocale({})).toBe('de');
  });
});

describe('config-locale: localeLandingPath', () => {
  const config = { locales: ['de', 'en'], landing_path: '/de/landing/' };

  it('rewrites locale segment for a different locale', () => {
    expect(localeLandingPath(config, 'en')).toBe('/en/landing/');
  });

  it('returns original path for the default locale', () => {
    expect(localeLandingPath(config, 'de')).toBe('/de/landing/');
  });

  it('returns path unchanged for the default locale', () => {
    const cfg = { locales: ['de'], landing_path: '/pages/landing/' };
    expect(localeLandingPath(cfg, 'de')).toBe('/pages/landing/');
  });

  it('appends the locale segment when the path has no default-locale segment', () => {
    // Prevents a non-default locale from colliding into the default dir.
    const cfg = { locales: ['de'], landing_path: '/pages/landing/' };
    expect(localeLandingPath(cfg, 'en')).toBe('/pages/landing/en/');
  });
});

describe('config-load: loadConfig', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges DEFAULTS for minimal config', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'project: x\n', 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.score_cutoff).toBe(DEFAULTS.score_cutoff);
    expect(cfg.weekly_cap).toBe(DEFAULTS.weekly_cap);
    expect(cfg.min_impressions).toBe(DEFAULTS.min_impressions);
    expect(cfg.counterpart_locale).toBeNull();
  });

  it('explicit value overrides default', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'score_cutoff: 9\n', 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.score_cutoff).toBe(9);
  });

  it('falls back to the default and warns when max_new_pages_per_month is not a number', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'max_new_pages_per_month: "lots"\n', 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.max_new_pages_per_month).toBe(DEFAULTS.max_new_pages_per_month);
    expect(cfg.config_warnings).toEqual([`max_new_pages_per_month must be a number, using ${DEFAULTS.max_new_pages_per_month}`]);
  });

  it('throws when config file is missing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    expect(() => loadConfig(tmpDir)).toThrow('seo.config.yaml not found');
  });
});
