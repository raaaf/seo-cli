import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { defaultLocale, localeLandingPath } from './config.js';

const slugsCache = new Map();
const titlesCache = new Map();

export function getExistingSlugs(config, cwd, locale) {
  const def = defaultLocale(config);
  const localePath = localeLandingPath(config, locale);
  const cacheKey = `${cwd}::${localePath}::${locale}::${def}`;
  if (slugsCache.has(cacheKey)) return slugsCache.get(cacheKey);

  const tryDirs = [localePath];
  if (locale !== def) tryDirs.push(config.landing_path);

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

/**
 * Slug, title and tldr of every landing page in a locale. The tldr is where the
 * cross-page numbers live (price corridors, percentages), so the fact checker
 * uses it to spot a new page contradicting its own cluster.
 */
export function getExistingPages(config, cwd = process.cwd(), locale) {
  const dir = join(cwd, localeLandingPath(config, locale ?? defaultLocale(config)));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const slug = f.replace('.md', '');
      try {
        const { parsed } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
        return { slug, title: parsed.meta_title ?? parsed.hero?.headline ?? slug, tldr: parsed.tldr ?? null };
      } catch {
        return { slug, title: slug, tldr: null };
      }
    });
}

export function getExistingTitles(landingPath, cwd = process.cwd()) {
  const cacheKey = `${cwd}::${landingPath}`;
  if (titlesCache.has(cacheKey)) return titlesCache.get(cacheKey);
  let titles;
  try {
    const dir = join(cwd, landingPath);
    if (!existsSync(dir)) { titlesCache.set(cacheKey, []); return []; }
    titles = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          const content = readFileSync(join(dir, f), 'utf8');
          const { parsed } = parseFrontmatter(content);
          const headline = parsed.hero?.headline ?? parsed.title ?? null;
          if (headline) return headline;
        } catch {}
        return f.replace('.md', '');
      });
  } catch {
    titles = [];
  }
  titlesCache.set(cacheKey, titles);
  return titles;
}
