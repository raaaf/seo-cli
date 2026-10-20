// Inbound internal links for landing pages.
//
// A new page links out to existing pages (`related_pages`, body links), but no
// existing page ever linked to it, so most pages sat with fewer than three
// inbound links. This module is pure: link counting, eligibility and the text
// edit. Which eligible pages are on topic is judged by a model (steps/link-judge.js).
import { parseFrontmatter } from './frontmatter.js';

const lastSegment = (href) => {
  const path = String(href).split(/[#?]/)[0].replace(/\/+$/, '');
  return path.split('/').pop();
};

const relatedList = (markdown) => {
  const list = parseFrontmatter(markdown).parsed.related_pages;
  return Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
};

/** Slugs a page links to: its `related_pages` entries plus its internal body links. */
export function linkTargets(markdown) {
  const slugs = new Set(relatedList(markdown).map(lastSegment));
  for (const [, href] of parseFrontmatter(markdown).body.matchAll(/\]\((\/(?!\/)[^)\s]*)\)/g)) slugs.add(lastSegment(href));
  slugs.delete('');
  return slugs;
}

/** Map slug -> Set of slugs linking to it, over `[{ slug, markdown }]`; self-links and unknown slugs are ignored. */
export function inboundLinks(pages) {
  const inbound = new Map(pages.map(p => [p.slug, new Set()]));
  for (const { slug, markdown } of pages) {
    for (const target of linkTargets(markdown)) {
      if (target !== slug && inbound.has(target)) inbound.get(target).add(slug);
    }
  }
  return inbound;
}

/**
 * The pages (`[{ slug, markdown, ... }]`, same locale) that may link to `targetSlug`: not the target,
 * not linking to it yet, with room left in `related_pages`. Whether they are on topic is not decided
 * here, see `judgeLinkSources` in `steps/link-judge.js`.
 */
export function eligibleSources({ targetSlug, pages, maxRelated = 4 }) {
  return pages.filter(p => p.slug !== targetSlug
    && !linkTargets(p.markdown).has(targetSlug)
    && relatedList(p.markdown).length < maxRelated);
}

/**
 * Adds `slug` to the `related_pages` list as a text edit, not a YAML round trip, so the rest of the
 * file stays byte for byte. New items copy the indentation and quoting of the last one; without a
 * list one is inserted before the closing `---`. Returns the input when the slug is already listed,
 * there is no frontmatter or `related_pages` has a form this edit does not know (inline list).
 */
export function addRelatedPage(markdown, slug) {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return markdown;
  const end = lines.indexOf('---', 1);
  if (end === -1) return markdown;

  const key = lines.findIndex((l, i) => i < end && /^related_pages:/.test(l));
  if (key === -1) {
    lines.splice(end, 0, 'related_pages:', `  - ${slug}`);
    return lines.join('\n');
  }
  if (!/^related_pages:\s*(#.*)?$/.test(lines[key])) return markdown;

  const itemRe = /^(\s*-\s+)(['"]?)([^'"\s#]+)\2/;
  let last = key;
  let style = { prefix: '  - ', quote: '' };
  for (let i = key + 1; i < end; i++) {
    const item = lines[i].match(itemRe);
    if (!item) break;
    if (item[3] === slug) return markdown;
    last = i;
    style = { prefix: item[1], quote: item[2] };
  }
  lines.splice(last + 1, 0, `${style.prefix}${style.quote}${slug}${style.quote}`);
  return lines.join('\n');
}
