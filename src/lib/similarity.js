// Keyword de-duplication.
//
// The W30 run produced "freelancer webdesign preise" and "webdesign freelancer
// preise" as two separate pages: different slugs, identical intent, contradicting
// numbers. Slug-collision checking cannot catch that, because the slugs differ.
//
// This module only catches the case it can decide with certainty: two keywords
// whose significant tokens are the same set. Everything fuzzier (is "zeiterfassung
// software vergleich" the same intent as "zeiterfassung tools freelancer
// vergleich"?) is a judgement call and belongs to the model, which gets the
// existing slugs and titles in the scoring prompt.

// Function words that carry no topical meaning in DE/EN search queries.
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'für', 'fuer', 'mit', 'ohne', 'von', 'vom', 'im', 'in', 'am', 'an',
  'auf', 'zu', 'zum', 'zur', 'als', 'bei', 'per', 'pro', 'ist', 'sind', 'wie', 'was',
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'without', 'of', 'to', 'in', 'on', 'at',
  'is', 'are', 'how', 'what',
]);

/**
 * Significant tokens of a keyword or slug, lowercased and de-duplicated.
 * Falls back to all tokens when every token is a stopword.
 */
export function tokenize(input) {
  const tokens = String(input || '')
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter(Boolean);
  const significant = tokens.filter(t => !STOPWORDS.has(t));
  return new Set(significant.length ? significant : tokens);
}

/** True when both inputs reduce to the same set of significant tokens. */
export function isSameTokenSet(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setA.size !== setB.size) return false;
  for (const token of setA) {
    if (!setB.has(token)) return false;
  }
  return true;
}

/**
 * First entry of `candidates` that is a word-order variant of `keyword`, or null.
 * Candidates may be keywords or slugs; both tokenize the same way.
 */
export function findTokenSetDuplicate(keyword, candidates = []) {
  return candidates.find(candidate => candidate && isSameTokenSet(keyword, candidate)) ?? null;
}
