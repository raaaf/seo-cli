// JSON-LD of a live page: is there any, does it parse, does a page with FAQ items carry a FAQPage. Pure.

const LD_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** `{ blocks, invalid }`: the parsed JSON-LD blocks and how many failed to parse. */
export function extractJsonLd(html) {
  const blocks = [];
  let invalid = 0;
  for (const [, body] of html.matchAll(LD_SCRIPT)) {
    try {
      blocks.push(JSON.parse(body));
    } catch {
      invalid += 1;
    }
  }
  return { blocks, invalid };
}

// Every @type in a block, walking array roots and @graph.
function typesOf(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach(n => typesOf(n, found));
  else if (node && typeof node === 'object') {
    for (const t of [].concat(node['@type'] ?? [])) found.add(t);
    typesOf(node['@graph'], found);
  }
  return found;
}

/**
 * Finding codes of a fetched page (`jsonld_missing`, `jsonld_invalid`, `faqpage_missing`; [] is clean), or null when the
 * page cannot be judged: body cut off, or no `<html` and `<title` (an error or maintenance page).
 */
export function structuredDataFindings({ html, hasFaq, truncated }) {
  if (truncated || !/<html/i.test(html) || !/<title/i.test(html)) return null;
  const { blocks, invalid } = extractJsonLd(html);
  if (invalid) return ['jsonld_invalid'];
  if (!blocks.length) return ['jsonld_missing'];
  return hasFaq && !blocks.some(b => typesOf(b).has('FAQPage')) ? ['faqpage_missing'] : [];
}
