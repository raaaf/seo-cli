import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { isValidSlug } from './keywords.js';
import { defaultLocale, localeLandingPath, isStrict } from './config.js';
import { pickLinkSources, addRelatedPage } from './inbound-links.js';

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
        const products = Array.isArray(parsed.products) ? parsed.products.filter(p => typeof p === 'string') : [];
        return { slug, title: parsed.meta_title ?? parsed.hero?.headline ?? slug, tldr: parsed.tldr ?? null, faq, updated: parsed.updated ?? null, products };
      } catch {
        return { slug, title: slug, tldr: null, faq: [], updated: null, products: [] };
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
// list free of duplicates; `to` null drops the entries instead. Text edit, not a YAML round
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
    if (to === null && from.includes(item[3])) continue;
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
 * so there are no chains), and every other page's `related_pages` repointed. With a
 * counterpart locale the merged pages' `alternate:` counterparts are deleted, redirected to
 * the survivor's counterpart (else its default-locale slug) and repointed the same way (dropped
 * from `related_pages` when the survivor has none). With `counterpart_url_prefix` the counterpart is
 * deleted without a redirect. Returns `{ files, counterparts, counterpartPrefix }`.
 */
export function buildMergeFiles({ survivor, mergeFrom, config, cwd = process.cwd() }) {
  const landingPath = localeLandingPath(config, defaultLocale(config));
  const dir = join(cwd, landingPath);
  const files = mergeFrom.map(slug => ({ path: join(landingPath, `${slug}.md`), delete: true }));

  // Counterpart locale: pages linked via `alternate:` go with their default-locale page.
  const cpLocale = config.counterpart_locale && config.counterpart_locale !== defaultLocale(config) ? config.counterpart_locale : null;
  const cpPath = cpLocale ? localeLandingPath(config, cpLocale) : null;
  const cpDir = cpPath ? join(cwd, cpPath) : null;
  const alternateOf = slug => {
    const file = join(dir, `${slug}.md`);
    if (!cpDir || !existsSync(file)) return null;
    const alt = parseFrontmatter(readFileSync(file, 'utf8')).parsed.alternate;
    return isValidSlug(alt) && existsSync(join(cpDir, `${alt}.md`)) ? alt : null;
  };
  const survivorAlt = alternateOf(survivor);
  // Keyed by counterpart slug, so an alternate shared by several merged pages is handled once.
  const cpMerged = new Map();
  for (const slug of mergeFrom) {
    const alt = alternateOf(slug);
    if (alt && alt !== survivorAlt) cpMerged.set(alt, survivorAlt || survivor);
  }
  // A prefixed counterpart URL (/en/slug) is not matched by the flat slug key of redirects.json.
  const needsManualRedirect = Boolean(config.counterpart_url_prefix);
  for (const alt of cpMerged.keys()) files.push({ path: join(cpPath, `${alt}.md`), delete: true });

  const redirectsPath = join(cwd, REDIRECTS_FILE);
  const redirects = existsSync(redirectsPath) ? JSON.parse(readFileSync(redirectsPath, 'utf8')) : {};
  for (const [from, to] of Object.entries(redirects)) {
    if (mergeFrom.includes(to)) redirects[from] = survivor;
    else if (cpMerged.has(to) && !needsManualRedirect) redirects[from] = cpMerged.get(to);
  }
  for (const slug of mergeFrom) redirects[slug] = survivor;
  if (!needsManualRedirect) for (const [alt, to] of cpMerged) redirects[alt] = to;
  files.push({ path: REDIRECTS_FILE, content: JSON.stringify(redirects, null, 2) + '\n' });

  const repointDir = (dirPath, relPath, touched, from, to) => {
    for (const name of readdirSync(dirPath).filter(f => f.endsWith('.md'))) {
      if (touched.has(name.replace(/\.md$/, ''))) continue;
      const current = readFileSync(join(dirPath, name), 'utf8');
      const updated = repointRelatedPages(current, from, to);
      if (updated !== current) files.push({ path: join(relPath, name), content: updated });
    }
  };
  repointDir(dir, landingPath, new Set([survivor, ...mergeFrom]), mergeFrom, survivor);
  if (cpMerged.size && existsSync(cpDir)) {
    repointDir(cpDir, cpPath, new Set([survivorAlt, ...cpMerged.keys()]), [...cpMerged.keys()], survivorAlt);
  }
  const counterparts = [...cpMerged].map(([slug, to]) => ({ slug, to, manualRedirect: needsManualRedirect }));
  return { files, counterparts, counterpartPrefix: config.counterpart_url_prefix || '' };
}

/** Slug, title and markdown of every landing page of a locale on disk; empty without the directory. */
export function readLandingPages(config, cwd = process.cwd(), locale = defaultLocale(config)) {
  const dir = join(cwd, localeLandingPath(config, locale));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const slug = f.replace(/\.md$/, '');
      const markdown = readFileSync(join(dir, f), 'utf8');
      const { parsed } = parseFrontmatter(markdown);
      return { slug, markdown, title: parsed.meta_title ?? parsed.hero?.headline ?? slug };
    });
}

/**
 * Edits that give each target page inbound links: for every `{ slug, text, max }` of `targets` the
 * pages of `locale` picked by `pickLinkSources` get the target added to `related_pages`. A source
 * picked for several targets ends up as one file entry. `exclude` are slugs whose files are already
 * part of the PR and are never edited. Returns `{ files: [{ path, content }], links: [{ source, target }] }`.
 */
export function buildInboundLinkFiles({ targets, config, cwd = process.cwd(), locale = defaultLocale(config), exclude = [] }) {
  const skip = new Set(exclude);
  const pages = readLandingPages(config, cwd, locale).filter(p => !skip.has(p.slug));
  const current = new Map(pages.map(p => [p.slug, p.markdown]));
  const links = [];
  for (const target of targets) {
    const candidates = pages.map(p => ({ ...p, markdown: current.get(p.slug) }));
    for (const source of pickLinkSources({ target, pages: candidates, max: target.max })) {
      const updated = addRelatedPage(current.get(source), target.slug);
      if (updated === current.get(source)) continue;
      current.set(source, updated);
      links.push({ source, target: target.slug });
    }
  }
  const landingPath = localeLandingPath(config, locale);
  const files = pages
    .filter(p => current.get(p.slug) !== p.markdown)
    .map(p => ({ path: join(landingPath, `${p.slug}.md`), content: current.get(p.slug) }));
  return { files, links };
}

/**
 * `buildInboundLinkFiles` for a PR that ships anyway: off with `inbound_links: false` or without a
 * landing path, and a failure becomes a warning (`onWarning`) and no extra files instead of an error.
 */
export function tryInboundLinkFiles(args, onWarning) {
  const none = { files: [], links: [] };
  if (args.config.inbound_links === false || !args.config.landing_path) return none;
  try {
    return buildInboundLinkFiles(args);
  } catch (e) {
    onWarning(`Inbound links skipped: ${e.message}`);
    return none;
  }
}

/** `source -> target` lines of a PR body section, empty without links. */
export function inboundLinksSection(links, heading = 'Inbound links') {
  if (!links.length) return '';
  return `\n## ${heading}\n\n${links.map(l => `- \`${l.source}\` -> \`${l.target}\``).join('\n')}\n`;
}
