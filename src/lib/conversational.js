// Google folds AI Mode and AI Overview activity into the ordinary web search
// query type, and counts every follow-up turn in a conversation as its own
// query. So conversation fragments, full natural-language prompts and
// AI-visibility-tracker probes land in the Search Console query table with
// impressions and positions, invisible to `discover`'s keyword logic. This
// module classifies query rows into buckets so a human can read what is
// actually going on. Pure pattern matching, no LLM: deterministic and free.

// Bare affirmations/continuations: a person replying to an AI, logged as if it
// were a search query. Evidence of AI Mode exposure, not a keyword to target.
const ARTEFACT_TOKENS = new Set([
  'ja', 'nein', 'ok', 'okay', 'danke', 'weiter', 'mehr', 'genau', 'doch',
  'yes', 'no', 'thanks', 'more', 'continue', 'sure', 'exactly',
]);

// Signatures of synthetic prompts issued by AI-visibility-tracking tools
// probing whether a brand gets mentioned. This list is necessarily incomplete
// and will need extending as more tools/patterns are identified.
const TRACKER_PROBE_PATTERNS = [
  // "... . my location is <place>." appended to give the AI a locale context.
  /\.\s*my location is [a-zäöüß\s]+\.?\s*$/i,
  // "evaluate <brand> on <facet>" — a structured brand-comparison prompt.
  /^evaluate\s+\S+\s+on\s+\S+/i,
];

// Openers that mark a real, conversational human question rather than a
// keyword-style search. German entries are listed with both real umlauts and
// their ae/oe/ue spellings, because queries arrive both ways.
const CONVERSATIONAL_OPENERS = [
  'wie kann ich', 'wie kann man',
  'was ist mit',
  'kannst du', 'koennen sie', 'können sie',
  'gibt es',
  'warum',
  'wie lange',
  'wie viel kostet', 'wieviel kostet',
  // English equivalents
  'how can i', 'how do i', 'what about', 'can you', 'could you',
  'is there', 'are there', 'why', 'how long', 'how much does',
];

// A query this long reads as a full sentence/prompt, not a keyword phrase,
// regardless of whether it opens with a recognisable question word.
const CONVERSATIONAL_WORD_COUNT = 9;

export const BUCKETS = ['artefact', 'tracker_probe', 'conversational', 'keyword'];

/** Classify a single query string into one of the four buckets. */
export function classifyQuery(query) {
  const q = String(query || '').trim();
  const lower = q.toLowerCase();

  // Tracker-probe signatures win over everything, including the artefact rule
  // (a probe can end on a single word) and the conversational-opener rule (a
  // probe suffix is itself often phrased as a question).
  if (TRACKER_PROBE_PATTERNS.some(re => re.test(lower))) return 'tracker_probe';

  const words = q.split(/\s+/).filter(Boolean);

  // Single-token rule, not substring: "ja" is an artefact, "ja oder nein bei
  // webdesign vertrag" is not.
  if (words.length === 1 && ARTEFACT_TOKENS.has(lower.replace(/[.!?]+$/, ''))) {
    return 'artefact';
  }
  // A bare number logged as a query ("1", "2") is the same kind of artefact.
  if (words.length === 1 && /^\d+$/.test(lower)) return 'artefact';

  if (CONVERSATIONAL_OPENERS.some(opener => lower.startsWith(opener))) return 'conversational';
  if (words.length >= CONVERSATIONAL_WORD_COUNT) return 'conversational';

  return 'keyword';
}

/**
 * Group GSC query rows by bucket. Rows: { query, page, position, impressions, clicks }.
 * Each bucket's rows are sorted by impressions descending; `keyword` is not
 * reported (ordinary search behaviour, nothing new to read here).
 */
export function groupConversational(rows) {
  const groups = { artefact: [], tracker_probe: [], conversational: [], keyword: [] };

  for (const row of rows) {
    groups[classifyQuery(row.query)].push(row);
  }

  for (const bucket of BUCKETS) {
    groups[bucket].sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  }

  const totals = {};
  for (const bucket of BUCKETS) {
    totals[bucket] = {
      count: groups[bucket].length,
      impressions: groups[bucket].reduce((sum, r) => sum + (r.impressions || 0), 0),
    };
  }

  return { artefact: groups.artefact, tracker_probe: groups.tracker_probe, conversational: groups.conversational, keyword: groups.keyword, totals };
}
