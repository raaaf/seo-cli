const PLACEHOLDER_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Strip `<<<...>>>` fence markers from untrusted external data before it is
 * embedded in a prompt. A crafted value containing a literal fence token
 * (e.g. `<<<UNTRUSTED_SERP_END>>>`) would break out of the data block and
 * could inject instructions into the model.
 *
 * Any run of three or more `<` or `>` characters is removed.
 * Normal SEO text never contains these sequences.
 */
export function sanitizeUntrusted(str) {
  return String(str ?? '').replace(/<<<+/g, '').replace(/>>>+/g, '');
}

/**
 * Replace all `{{key}}` placeholders in `template` with values from `vars`.
 * - Single-pass: substituted content is never re-scanned for placeholders.
 *   Protects against double-substitution attacks where a value contains
 *   another `{{key}}` literal.
 * - Missing keys: the placeholder is left untouched so unfilled templates
 *   stay visible in test output rather than silently rendering "undefined".
 * - All values are passed through `sanitizeUntrusted` before substitution to
 *   strip `<<<...>>>` fence markers that could break prompt data blocks.
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(PLACEHOLDER_REGEX, (match, key) =>
    key in vars ? sanitizeUntrusted(vars[key]) : match
  );
}
