import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const slugsCache = new Map();

export function getExistingSlugs(config, cwd, locale) {
  const defaultLocale = config.locales?.[0] ?? config.locale ?? 'de';
  const basePath = config.landing_path;
  const localePath = basePath.includes(`/${defaultLocale}/`)
    ? basePath.replace(`/${defaultLocale}/`, `/${locale}/`)
    : basePath;
  const cacheKey = `${cwd}::${localePath}::${locale}::${defaultLocale}`;
  if (slugsCache.has(cacheKey)) return slugsCache.get(cacheKey);

  const tryDirs = [localePath];
  if (locale !== defaultLocale) tryDirs.push(basePath);

  let result = [];
  for (const dir of tryDirs) {
    try {
      const full = join(cwd, dir);
      if (!existsSync(full)) continue;
      const slugs = readdirSync(full)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
      if (slugs.length > 0) { result = slugs; break; }
    } catch {}
  }
  slugsCache.set(cacheKey, result);
  return result;
}

export function getExistingTitles(landingPath, cwd) {
  try {
    const dir = join(cwd, landingPath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          const content = readFileSync(join(dir, f), 'utf8');
          const headlineMatch = content.match(/headline:\s*["']?(.+?)["']?\s*$/m);
          if (headlineMatch) return headlineMatch[1].trim();
        } catch {}
        return f.replace('.md', '');
      });
  } catch {
    return [];
  }
}
