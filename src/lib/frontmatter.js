import yaml from 'js-yaml';

const FM_REGEX = /^---\n([\s\S]+?)\n---/;

/**
 * Split a markdown document into its frontmatter source string and the body.
 * Returns { fm, body, matched } where:
 *  - fm: the raw YAML source between the --- markers (without the markers); empty string if no frontmatter
 *  - body: the markdown body (trimmed); the whole input if no frontmatter
 *  - matched: true if a frontmatter block was found
 */
export function splitFrontmatter(markdown) {
  const m = String(markdown ?? '').match(FM_REGEX);
  if (!m) return { fm: '', body: String(markdown ?? '').trim(), matched: false };
  const body = String(markdown).slice(m[0].length).trim();
  return { fm: m[1], body, matched: true };
}

/**
 * Parse the frontmatter of a markdown document into a JS object.
 * Returns { parsed, body, matched, error }:
 *  - parsed: the loaded object, or {} on parse error or no frontmatter
 *  - body: the markdown body after the frontmatter (trimmed)
 *  - matched: true if a frontmatter block was found
 *  - error: the yaml.YAMLException if parsing failed, otherwise null
 */
export function parseFrontmatter(markdown) {
  const { fm, body, matched } = splitFrontmatter(markdown);
  if (!matched) return { parsed: {}, body, matched: false, error: null };
  try {
    const parsed = yaml.load(fm) || {};
    return { parsed, body, matched: true, error: null };
  } catch (e) {
    return { parsed: {}, body, matched: true, error: e };
  }
}
