const PLACEHOLDER_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Replace all `{{key}}` placeholders in `template` with values from `vars`.
 * - Single-pass: substituted content is never re-scanned for placeholders.
 *   Protects against double-substitution attacks where a value contains
 *   another `{{key}}` literal.
 * - Missing keys: the placeholder is left untouched so unfilled templates
 *   stay visible in test output rather than silently rendering "undefined".
 * - All values are coerced to String.
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(PLACEHOLDER_REGEX, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}
