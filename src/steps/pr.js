import chalk from 'chalk';
import { createBranchAndCommit, openPR, deleteBranch } from '../lib/github.js';
import { isoWeek, format } from '../lib/date.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { KEYWORD_STATUS, releasePending } from '../lib/keywords.js';
import { SEO_THRESHOLDS } from '../lib/seo-thresholds.js';
import { localeUrlPath, defaultLocale } from '../lib/config.js';

// Counterpart pages (config.counterpart_locale) share the bare /{slug} URL space
// with the default locale by default (no locale prefix), or
// `${counterpart_url_prefix}/{slug}` when the target site serves them under
// their own path segment, unlike the hreflang multi-locale mode's
// /{locale}/{slug} paths.
function sitemapSlug(page, config) {
  const isCounterpart = config.counterpart_locale && page.locale === config.counterpart_locale;
  return isCounterpart ? `${config.counterpart_url_prefix || ''}/${page.slug}` : localeUrlPath(config, page.slug, page.locale);
}

const safeKeyword = (kw) => String(kw ?? '').replace(/\r?\n/g, ' ').slice(0, 200);

/**
 * One PR per keyword, on seo/new/<slug of the default-locale page>, carrying all
 * locale files and the counterpart of that keyword. No state files: they go to
 * main through commitState. Each PR's url and the sitemap slugs to queue once it
 * merges are stored on the keyword entry.
 *
 * A failing PR never stops the others: its keyword goes back to `proposed`. An
 * existing branch (open PR for the same keyword) is a warning, any other
 * failure an error. Returns `{ prs: [{ url, keyword, slug }], warnings, errors }`.
 */
export async function createPRs({ generatedPages, keywordsData, config }) {
  const locales = config.locales || [config.locale || 'de'];
  // hreflang needs every locale of a slug, so it runs over the whole run
  // before the pages are split up by keyword.
  const enrichedPages = locales.length > 1 ? injectHreflang(generatedPages, config) : generatedPages;

  const byKeyword = new Map();
  for (const page of enrichedPages) {
    if (!byKeyword.has(page.keyword)) byKeyword.set(page.keyword, []);
    byKeyword.get(page.keyword).push(page);
  }

  const result = { prs: [], warnings: [], errors: [] };
  for (const [keyword, pages] of byKeyword) {
    const slug = (pages.find(p => p.locale === defaultLocale(config)) ?? pages[0]).slug;
    const branch = `seo/new/${slug}`;
    const kw = keywordsData.keywords.find(k => k.keyword === keyword);
    const sitemapSlugs = [...new Set(pages.map(p => sitemapSlug(p, config)))];

    let branchCreated = false;
    try {
      console.log(chalk.blue(`  Creating branch ${branch}, committing ${pages.length} file(s)...`));
      await createBranchAndCommit({
        files: pages.map(p => ({ path: p.filePath, content: p.markdown })),
        message: `seo: add landing page for ${safeKeyword(keyword)} (${isoWeek()})`,
        repo: config.repo,
        branch,
      });
      branchCreated = true;
      const url = await openPR({
        repo: config.repo,
        branch,
        title: `SEO: new page ${slug}`,
        body: buildPRBody(pages, sitemapSlugs, config),
      });
      console.log(chalk.green(`  PR opened: ${url}`));
      if (kw) Object.assign(kw, { status: KEYWORD_STATUS.PR_OPENED, pr_url: url, sitemap_slugs: sitemapSlugs });
      result.prs.push({ url, keyword, slug });
    } catch (e) {
      if (branchCreated) await deleteBranch({ repo: config.repo, branch }).catch(() => {}); // else the orphan blocks the keyword for good
      if (kw) releasePending([kw]);
      if (e.code === 'BRANCH_EXISTS') {
        const warning = `PR skipped for "${keyword}": branch ${branch} already exists (open PR for the same keyword)`;
        console.log(chalk.yellow(`  ${warning}`));
        result.warnings.push(warning);
      } else {
        console.error(chalk.red(`\nPR creation failed for "${keyword}": ${e.message}`));
        result.errors.push(`PR creation failed for "${keyword}": ${e.message}`);
      }
    }
  }
  return result;
}

function injectHreflang(pages, config) {
  // Group by slug, add hreflang block to each locale's frontmatter
  const bySlug = {};
  for (const p of pages) {
    if (!bySlug[p.slug]) bySlug[p.slug] = {};
    bySlug[p.slug][p.locale] = p;
  }

  return pages.map(p => {
    const siblings = bySlug[p.slug];
    const hreflangLines = Object.entries(siblings)
      .map(([loc, sibling]) => `  ${loc}: ${localeUrlPath(config, sibling.slug, loc)}`)
      .join('\n');

    const hreflangBlock = `hreflang:\n${hreflangLines}`;
    const markdown = p.markdown.replace(/^(---\n[\s\S]+?)\n---/, (_, fm) => `${fm}\n${hreflangBlock}\n---`);
    return { ...p, markdown };
  });
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

  const { metaTitle: mt, metaDescription: md, tldrWords: tw, bodyWords: bw, extLinksMin } = SEO_THRESHOLDS;
  return [
    `| meta_title (${titleLen} chars) | ${status(titleLen >= mt.idealMin && titleLen <= mt.idealMax, titleLen >= mt.okMin && titleLen <= mt.okMax)} |`,
    `| meta_description (${descLen} chars) | ${status(descLen >= md.idealMin && descLen <= md.idealMax, descLen >= md.okMin && descLen <= md.okMax)} |`,
    `| tldr (${tldrWords} words) | ${status(tldrWords >= tw.idealMin && tldrWords <= tw.idealMax, tldrWords >= tw.okMin && tldrWords <= tw.okMax)} |`,
    `| body words (${bodyWords}) | ${status(bodyWords >= bw.okMin, bodyWords >= bw.warnMin)} |`,
    `| external links (${extLinks}) | ${status(extLinks >= extLinksMin, extLinks === 0)} |`,
    `| FAQ entries | ${hasFaq ? '✅' : '❌'} |`,
    `| related_pages | ${hasRelated ? '✅' : '⚠️'} |`,
  ].join('\n');
}

function buildPRBody(pages, sitemapSlugs, config) {
  const rows = pages.map(p =>
    `| ${mdCell(p.keyword)} | \`${mdCell(p.slug)}\` | ${mdCell(p.locale || config.locale)} | ${mdCell(p.score)} | ${mdCell(p.type)} |`
  ).join('\n');

  const seoRows = pages.map(p => `### \`${p.slug}\`\n| Check | Status |\n|---|---|\n${seoCheck(p)}`).join('\n\n');

  const sitemapNote = sitemapSlugs.length
    ? `\n## Sitemap\n\nQueued in \`seo/sitemap-pending.json\` once this PR is merged, Google picks them up via the sitemap after deploy:\n${sitemapSlugs.map(s => `- \`${s}\``).join('\n')}`
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
