// Inbound internal links for landing pages.
//
// A new page links out to existing pages (`related_pages`, body links), but no
// existing page ever linked to it, so most pages sat with fewer than three
// inbound links. Everything here is deterministic: sources are chosen by token
// overlap between the target's topic and a candidate's title and slug, never by
// a model, and a candidate with no overlap is never linked.
import { parseFrontmatter } from './frontmatter.js';
import { tokenize } from './similarity.js';

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

// German compounds: "hochzeit" matches "hochzeitsplanung", but a short token such as "web" does not match "webinar".
const tokensMatch = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short);
};

/**
 * Tokens of `a` that match a token of `b`, each token of `a` once. A token in `ignore`, or a match
 * through one, does not count.
 */
export function matchedTokens(a, b, ignore = new Set()) {
  const tokensB = [...tokenize(b)].filter(t => !ignore.has(t));
  return [...tokenize(a)].filter(token => !ignore.has(token) && tokensB.some(other => tokensMatch(token, other)));
}

/** Number of significant tokens of `a` that match a token of `b`; each token of `a` counts once. */
export function topicOverlap(a, b, ignore) {
  return matchedTokens(a, b, ignore).length;
}

// A token that is in more than 20 percent of the texts, and in at least 3, says nothing about a
// topic on this site ("organisieren", "party"). A compound counts for its shorter token.
function genericTokens(texts) {
  const sets = texts.map(t => [...tokenize(t)]);
  const generic = new Set();
  for (const token of new Set(sets.flat())) {
    const df = sets.filter(tokens => tokens.some(other => tokensMatch(token, other))).length;
    if (df >= 3 && df / texts.length > 0.2) generic.add(token);
  }
  return generic;
}

/**
 * Up to `max` `{ slug, via }` of `pages` (`[{ slug, markdown, title }]`, same locale) that should
 * link to `target` (`{ slug, text }`): on topic, not linking to it yet, with room left in
 * `related_pages`. `via` are the shared tokens. Tokens generic for the site do not count. Best
 * overlap first, then fewer related entries, then slug, so the pick is deterministic.
 */
export function pickLinkSources({ target, pages, max = 3, maxRelated = 4 }) {
  const textOf = p => `${p.title ?? ''} ${p.slug}`;
  const ignore = genericTokens([target.text, ...pages.filter(p => p.slug !== target.slug).map(textOf)]);
  return pages
    .filter(p => p.slug !== target.slug && !linkTargets(p.markdown).has(target.slug))
    .map(p => ({ slug: p.slug, related: relatedList(p.markdown).length, via: matchedTokens(target.text, textOf(p), ignore) }))
    .filter(c => c.related < maxRelated && c.via.length >= 1)
    .sort((a, b) => b.via.length - a.via.length || a.related - b.related || a.slug.localeCompare(b.slug))
    .slice(0, max)
    .map(c => ({ slug: c.slug, via: c.via }));
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
