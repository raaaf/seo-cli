import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { defaultLocale, localeLandingPath, loadConfig, isStrict, DEFAULTS } from '../src/lib/config.js';

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
    expect(cfg.icp_doc).toBe('seo/icp.md');
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

  it('leaves the Etappe D keys inert when absent', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'project: x\n', 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.page_contract).toBeNull();
    expect(cfg.overlays).toBeNull();
    expect(cfg.catalog_url).toBeNull();
    expect(cfg.reserved_slugs).toEqual([]);
    expect(cfg.watch).toEqual({ check_deploy: false });
    expect(cfg.config_warnings).toBeUndefined();
  });

  it('reads the Etappe D keys and merges watch with its defaults', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), [
      'catalog_url: https://example.test/seo/catalog.json',
      'reserved_slugs: [admin, up]',
      'page_contract: { body_words: [300, 600] }',
      'overlays: { products: content/seo/products }',
      'watch: { check_deploy: true }',
    ].join('\n'), 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.catalog_url).toBe('https://example.test/seo/catalog.json');
    expect(cfg.reserved_slugs).toEqual(['admin', 'up']);
    expect(cfg.page_contract.body_words).toEqual([300, 600]);
    expect(cfg.overlays.products).toBe('content/seo/products');
    expect(cfg.watch.check_deploy).toBe(true);
  });

  it('ignores malformed Etappe D keys with warnings', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'page_contract: nope\noverlays: [a]\nreserved_slugs: admin\nwatch: 3\n', 'utf8');
    const cfg = loadConfig(tmpDir);
    expect(cfg.page_contract).toBeNull();
    expect(cfg.overlays).toBeNull();
    expect(cfg.reserved_slugs).toEqual([]);
    expect(cfg.watch).toEqual({ check_deploy: false });
    expect(cfg.config_warnings).toHaveLength(3);
  });

  it('keeps Bing off by default and merges a partial bing mapping with its defaults', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'project: x\n', 'utf8');
    expect(loadConfig(tmpDir).bing).toEqual({ enabled: false, site_url: null });
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'bing: { enabled: true }\n', 'utf8');
    expect(loadConfig(tmpDir).bing).toEqual({ enabled: true, site_url: null });
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'bing: 3\n', 'utf8');
    expect(loadConfig(tmpDir).bing).toEqual({ enabled: false, site_url: null });
  });

  it('throws a config error naming the page_contract key with a wrong shape', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    writeFileSync(join(tmpDir, 'seo.config.yaml'), 'page_contract:\n  body_words: [300]\n', 'utf8');
    expect(() => loadConfig(tmpDir)).toThrow('page_contract.body_words must be a list of two numbers');
  });

  it('throws when config file is missing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    expect(() => loadConfig(tmpDir)).toThrow('seo.config.yaml not found');
  });
});

describe('config-quality', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const load = (extra) => {
    dir = mkdtempSync(join(tmpdir(), 'seo-quality-'));
    writeFileSync(join(dir, 'seo.config.yaml'), `project: x\nlanding_path: a/\n${extra}`);
    return loadConfig(dir);
  };

  it('is standard unless the config says strict', () => {
    expect(isStrict(load(''))).toBe(false);
    expect(isStrict(load('quality: strict\n'))).toBe(true);
  });
});
