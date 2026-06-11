import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const CONFIG_FILE = 'seo.config.yaml';

export function loadConfig(cwd = process.cwd()) {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error(`${CONFIG_FILE} not found. Run "seo init" first.`);
  }
  return { ...DEFAULTS, ...(yaml.load(readFileSync(path, 'utf8')) || {}) };
}

export function saveConfig(config, cwd = process.cwd()) {
  const path = join(cwd, CONFIG_FILE);
  writeFileSync(path, yaml.dump(config, { lineWidth: 120 }), 'utf8');
}

export const DEFAULTS = {
  locale: 'de',
  primary_cta: 'trial_signup',
  style_doc: null,
  score_cutoff: 7,
  weekly_cap: 2,
  min_impressions: 5,
};

export function defaultLocale(config) {
  return config.locales?.[0] ?? config.locale ?? 'de';
}

export function localeLandingPath(config, locale) {
  const base = config.landing_path;
  const def = defaultLocale(config);
  return base.includes(`/${def}/`) ? base.replace(`/${def}/`, `/${locale}/`) : base;
}
