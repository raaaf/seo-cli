// Topics the site owner does not offer. A keyword that names one is never scored,
// proposed or generated, whatever its demand in Search Console.
//
// Added after portfolio-2025 got a third Webflow page (2026-W45) although Rafael
// does not build with Webflow: the style doc forbids claiming the service, so the
// model wrote honest "I don't do Webflow" comparison pages, but the topic itself
// was never wanted. The style doc steers the text, this list steers the topics.
//
// Matching is deterministic: lowercase, every non-letter becomes a space, and a
// term matches at the start of a word, so "webflow" catches "webflow website",
// "webflow-agentur" and "webflowseite", but not "nowebflow".

const normalize = s => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim()} `;

/** The first configured term the keyword (or slug) names, or null. */
export function matchExcludedTerm(keyword, terms = []) {
  const text = normalize(keyword);
  for (const term of terms) {
    const needle = normalize(term).trimEnd();
    if (needle.trim() && text.includes(needle)) return term;
  }
  return null;
}
