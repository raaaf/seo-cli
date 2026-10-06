import { generateCounterpart } from './counterpart.js';
import { validate } from './validate.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { rethrowIfBudget } from '../lib/budget.js';

const COUNTED_FIELDS = ['steps', 'checklist', 'faq'];

const count = (parsed, field) => (Array.isArray(parsed[field]) ? parsed[field].length : 0);

// Portfolio's landing-sync test requires equal steps/checklist/faq counts per
// counterpart pair, so a drifting count is a validation error, not a warning.
function structureMismatches(sourceMarkdown, counterpartMarkdown) {
  const source = parseFrontmatter(sourceMarkdown).parsed ?? {};
  const target = parseFrontmatter(counterpartMarkdown).parsed ?? {};
  return COUNTED_FIELDS
    .filter(f => count(source, f) !== count(target, f))
    .map(f => `${f} count differs from the source page: ${count(target, f)} instead of ${count(source, f)}`);
}

/**
 * Generate a counterpart page and validate it, up to 2 attempts, feeding the
 * validator errors back on the retry. Returns `{ markdown, slug }`, or
 * `{ failure, errors }` when generation throws or validation never passes.
 *
 * `opts.matchCounts` also requires steps/checklist/faq counts to equal the
 * source page's; the rest of `opts` goes to `generateCounterpart`.
 */
export async function generateValidatedCounterpart(kw, sourceMarkdown, config, cwd, opts = {}) {
  const { matchCounts = false, ...generateOpts } = opts;
  let validatorFeedback = null;
  let errors = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    let result;
    try {
      result = await generateCounterpart(sourceMarkdown, kw, config, cwd, { ...generateOpts, validatorFeedback });
    } catch (e) {
      rethrowIfBudget(e);
      return { failure: e.message, errors: [] };
    }
    errors = [
      ...validate(result.markdown, kw, { counterpart: true }).errors,
      ...(matchCounts ? structureMismatches(sourceMarkdown, result.markdown) : []),
    ];
    if (errors.length === 0) return result;
    validatorFeedback = errors.join('\n');
  }
  return { failure: 'validation failed after 2 attempts', errors };
}
