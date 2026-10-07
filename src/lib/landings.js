import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { defaultLocale, localeLandingPath, isStrict } from './config.js';

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
        const faq = Array.isArray(parsed.faq) ? parsed.faq.map(f => f?.a).filter(a => typeof a === 'string') : [];
        return { slug, title: parsed.meta_title ?? parsed.hero?.headline ?? slug, tldr: parsed.tldr ?? null, faq, updated: parsed.updated ?? null };
      } catch {
        return { slug, title: slug, tldr: null, faq: [], updated: null };
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

/** Slug and markdown body of every landing page in `dir`, minus the `exclude` slugs. */
export function loadPageBodies(dir, exclude = []) {
  if (!existsSync(dir)) return [];
  const skip = new Set(exclude);
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && !skip.has(f.replace(/\.md$/, '')))
    .map(f => ({ slug: f.replace(/\.md$/, ''), body: parseFrontmatter(readFileSync(join(dir, f), 'utf8')).body }));
}

/**
 * The `opts` validate() takes for a page in `dir` (absolute). Empty unless the
 * project (or the caller, via `strict`) asked for strict quality, so a standard
 * project validates exactly as before. `exclude` is the page's own slug plus the
 * pages being merged into it: repeating those is the point of a merge.
 */
export function strictValidateOpts(config, dir, exclude = [], strict = isStrict(config)) {
  return strict ? { strict: true, otherPages: loadPageBodies(dir, exclude) } : {};
}

export const REDIRECTS_FILE = 'seo/redirects.json';

// Rewrites the `related_pages:` list entries named in `from` to `to`, keeping the
// list free of duplicates. Text edit, not a YAML round
// trip, so the rest of the file stays byte for byte.
function repointRelatedPages(markdown, from, to) {
  const lines = markdown.split('\n');
  const out = [];
  let inList = false;
  let seen = new Set();
  for (const line of lines) {
    if (/^related_pages:\s*$/.test(line)) { inList = true; seen = new Set(); out.push(line); continue; }
    if (inList && !/^\s*-\s/.test(line)) inList = false;
    const item = inList ? line.match(/^(\s*-\s*)(['"]?)([^'"\s#]+)\2(\s*(?:#.*)?)$/) : null;
    if (!item) { out.push(line); continue; }
    const slug = from.includes(item[3]) ? to : item[3];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug === item[3] ? line : `${item[1]}${item[2]}${slug}${item[2]}${item[4]}`);
  }
  return out.join('\n');
}

/**
 * Extra files of a merge PR: the merged pages deleted, `seo/redirects.json` with
 * old slug -> survivor (existing targets pointing at a merged page follow along,
 * so there are no chains), and every other page's `related_pages` repointed.
 */
export function buildMergeFiles({ survivor, mergeFrom, config, cwd = process.cwd() }) {
  const landingPath = localeLandingPath(config, defaultLocale(config));
  const dir = join(cwd, landingPath);
  const files = mergeFrom.map(slug => ({ path: join(landingPath, `${slug}.md`), delete: true }));

  const redirectsPath = join(cwd, REDIRECTS_FILE);
  const redirects = existsSync(redirectsPath) ? JSON.parse(readFileSync(redirectsPath, 'utf8')) : {};
  for (const [from, to] of Object.entries(redirects)) if (mergeFrom.includes(to)) redirects[from] = survivor;
  for (const slug of mergeFrom) redirects[slug] = survivor;
  files.push({ path: REDIRECTS_FILE, content: JSON.stringify(redirects, null, 2) + '\n' });

  const touched = new Set([survivor, ...mergeFrom]);
  for (const name of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const slug = name.replace(/\.md$/, '');
    if (touched.has(slug)) continue;
    const current = readFileSync(join(dir, name), 'utf8');
    const updated = repointRelatedPages(current, mergeFrom, survivor);
    if (updated !== current) files.push({ path: join(landingPath, name), content: updated });
  }
  return files;
}
