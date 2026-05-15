import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { createBranchAndCommit, openPR } from '../lib/github.js';
import { isoWeek, format } from '../lib/date.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { KEYWORDS_FILE, SITEMAP_PENDING_FILE } from '../lib/keywords.js';

function localeSlug(slug, locale, locales) {
  return `/${locale === locales[0] ? '' : locale + '/'}${slug}`;
}

export async function createPR({ generatedPages, keywordsJsonContent, config, cwd = process.cwd() }) {
  const week = isoWeek();
  const branch = `seo/${week}`;

  // Build sitemap pending list
  const sitemapPending = loadSitemapPending(cwd);
  const locales = config.locales || [config.locale || 'de'];
  for (const page of generatedPages) {
    const slug = localeSlug(page.slug, page.locale, locales);
    if (!sitemapPending.slugs.includes(slug)) sitemapPending.slugs.push(slug);
  }

  // Add hreflang frontmatter for multi-locale pages
  const enrichedPages = locales.length > 1
    ? injectHreflang(generatedPages, locales)
    : generatedPages;

  const files = [
    ...enrichedPages.map(p => ({ path: p.filePath, content: p.markdown })),
    { path: KEYWORDS_FILE, content: JSON.stringify(keywordsJsonContent, null, 2) + '\n' },
    { path: SITEMAP_PENDING_FILE, content: JSON.stringify(sitemapPending, null, 2) + '\n' },
  ];

  const safeKeyword = (kw) => String(kw ?? '').replace(/\r?\n/g, ' ').slice(0, 200);
  const commitMsg = `seo: add landing pages for ${week}\n\n${generatedPages.map(p => `- ${safeKeyword(p.keyword)}`).join('\n')}`;

  console.log(chalk.blue(`  Creating branch ${branch}, committing ${files.length} files...`));

  await createBranchAndCommit({ files, message: commitMsg, cwd, repo: config.repo });

  const prBody = buildPRBody(enrichedPages, sitemapPending, config);
  const prUrl = await openPR({
    repo: config.repo,
    branch,
    title: `SEO: landing pages ${week} (${generatedPages.length} pages)`,
    body: prBody,
  });

  console.log(chalk.green(`  PR opened: ${prUrl}`));
  return prUrl;
}

function injectHreflang(pages, locales) {
  // Group by slug, add hreflang block to each locale's frontmatter
  const bySlug = {};
  for (const p of pages) {
    if (!bySlug[p.slug]) bySlug[p.slug] = {};
    bySlug[p.slug][p.locale] = p;
  }

  return pages.map(p => {
    const siblings = bySlug[p.slug];
    const hreflangLines = Object.entries(siblings)
      .map(([loc, sibling]) => `  ${loc}: ${localeSlug(sibling.slug, loc, locales)}`)
      .join('\n');

    const hreflangBlock = `hreflang:\n${hreflangLines}`;
    const markdown = p.markdown.replace(/^(---\n[\s\S]+?)\n---/, (_, fm) => `${fm}\n${hreflangBlock}\n---`);
    return { ...p, markdown };
  });
}

function loadSitemapPending(cwd) {
  const path = join(cwd, SITEMAP_PENDING_FILE);
  if (!existsSync(path)) return { updated: null, slugs: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { updated: null, slugs: [] }; }
}

function mdCell(str) {
  return String(str ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function seoCheck(page) {
  const { parsed, body } = parseFrontmatter(page.markdown);

  const metaTitle = String(parsed.meta_title ?? '');
  const metaDesc = String(parsed.meta_description ?? '');
  const tldr = String(parsed.tldr ?? '');
  const titleLen = metaTitle.length;
  const descLen = metaDesc.length;
  const tldrWords = tldr.split(/\s+/).filter(Boolean).length;
  const bodyWords = body.split(/\s+/).filter(Boolean).length;
  const extLinks = (body.match(/\[.*?\]\(https?:\/\//g) ?? []).length;
  const hasFaq = Array.isArray(parsed.faq) && parsed.faq.length > 0;
  const hasRelated = Array.isArray(parsed.related_pages) && parsed.related_pages.length > 0;

  const status = (ok, warn) => ok ? '✅' : warn ? '⚠️' : '❌';

  return [
    `| meta_title (${titleLen} chars) | ${status(titleLen >= 50 && titleLen <= 60, titleLen >= 45 && titleLen <= 65)} |`,
    `| meta_description (${descLen} chars) | ${status(descLen >= 140 && descLen <= 160, descLen >= 130 && descLen <= 165)} |`,
    `| tldr (${tldrWords} words) | ${status(tldrWords >= 40 && tldrWords <= 60, tldrWords >= 35 && tldrWords <= 65)} |`,
    `| body words (${bodyWords}) | ${status(bodyWords >= 800, bodyWords >= 700)} |`,
    `| external links (${extLinks}) | ${status(extLinks >= 1, extLinks === 0)} |`,
    `| FAQ entries | ${hasFaq ? '✅' : '❌'} |`,
    `| related_pages | ${hasRelated ? '✅' : '⚠️'} |`,
  ].join('\n');
}

function buildPRBody(pages, sitemapPending, config) {
  const rows = pages.map(p =>
    `| ${mdCell(p.keyword)} | \`${mdCell(p.slug)}\` | ${mdCell(p.locale || config.locale)} | ${mdCell(p.score)} | ${mdCell(p.type)} |`
  ).join('\n');

  const seoRows = pages.map(p => `### \`${p.slug}\`\n| Check | Status |\n|---|---|\n${seoCheck(p)}`).join('\n\n');

  const sitemapNote = sitemapPending.slugs.length
    ? `\n## Sitemap\n\nNew slugs queued in \`seo/sitemap-pending.json\` — Google will pick them up via the sitemap after deploy:\n${sitemapPending.slugs.map(s => `- \`${s}\``).join('\n')}`
    : '';

  return `## New landing pages

| Keyword | Slug | Locale | Score | Type |
|---|---|---|---|---|
${rows}

## SEO check

${seoRows}

## Review checklist
- [ ] Tone and style on point
- [ ] Facts are correct
- [ ] Internal links resolve
- [ ] CTA makes sense in context
${pages.some(p => p.locale) ? '- [ ] hreflang pairs match across locales' : ''}
${sitemapNote}

Generated by seo-cli on ${format(new Date())}`;
}
