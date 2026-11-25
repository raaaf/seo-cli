import { ctrDeficit } from '../steps/improve.js';
import { takePicks } from './queue.js';

// Question and purchase-intent queries a page already shows up for and loses the click on. Pure pattern
// matching, no LLM. The matching is done in code on Unicode word tokens: a Search Console regex filter
// (RE2) does not treat umlauts as word characters, so `\bwürde\b` would never match there.

// Openers of a question, German with real umlauts and their ae/oe/ue spellings (queries arrive both ways),
// plus English for the counterpart audience. Only the first token counts: "was kostet", not "bis was".
const QUESTION_OPENERS = new Set([
  'wer', 'was', 'wann', 'wo', 'woher', 'wohin', 'warum', 'wieso', 'weshalb', 'wozu', 'wie', 'wieviel', 'wieviele',
  'welche', 'welcher', 'welches', 'welchen', 'welchem',
  'kann', 'kannst', 'können', 'koennen', 'könnte', 'koennte', 'soll', 'sollte', 'sollten', 'muss', 'müssen', 'muessen',
  'darf', 'dürfen', 'duerfen', 'ist', 'sind', 'gibt', 'hat', 'haben', 'braucht', 'brauche', 'lohnt', 'reicht', 'würde', 'wuerde',
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'can', 'could', 'should', 'would', 'will',
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'has', 'have',
]);

// Purchase intent, anywhere in the query. Stems match a token start ("preise", "günstige"), words match whole.
const PURCHASE_STEMS = ['kosten', 'kostet', 'preis', 'günstig', 'guenstig', 'billig', 'erfahrung', 'vergleich', 'testsieger'];
const PURCHASE_WORDS = new Set([
  'kaufen', 'kauf', 'bestellen', 'test', 'beste', 'bester', 'bestes', 'besten', 'vs',
  'cost', 'costs', 'price', 'prices', 'pricing', 'cheap', 'cheapest', 'buy', 'best', 'review', 'reviews', 'versus',
]);

/** Lower-case word tokens, letters and digits of any script. */
export const tokens = (query) => String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * `question` (opens with a question word or ends with `?`), `purchase` (names price, cost, buying, a
 * comparison or experience) or null. A question about the price is a question: the FAQ answers it either way.
 */
export function questionKind(query) {
  const t = tokens(query);
  if (!t.length) return null;
  if (QUESTION_OPENERS.has(t[0]) || String(query).trim().endsWith('?')) return 'question';
  if (t.some(w => PURCHASE_WORDS.has(w) || PURCHASE_STEMS.some(s => w.startsWith(s)))) return 'purchase';
  return null;
}

// A query below this many impressions is noise for a FAQ entry; a page needs this many in total.
export const MIN_QUERY_IMPRESSIONS = 10;
export const MIN_PAGE_IMPRESSIONS = 40;
// Only queries a FAQ entry can still move: within reach of page one.
const MAX_POSITION = 20;
// Like the snippet rule: the click is lost when the CTR sits below half of what the position returns.
const MIN_DEFICIT = 0.5;
// Questions handed to the model per page.
export const MAX_QUESTIONS = 8;

/**
 * The question and purchase queries of one page that lose the click: own queries only (another page
 * ranks better for the rest), within reach, enough impressions, CTR well below the position's norm.
 * Sorted by impressions.
 */
export function questionGaps(queries) {
  return queries
    .map(q => ({ ...q, kind: questionKind(q.query) }))
    .filter(q => q.kind && q.position <= MAX_POSITION && q.impressions >= MIN_QUERY_IMPRESSIONS
      && ctrDeficit({ position: q.position, ctr: q.impressions ? q.clicks / q.impressions : 0 }) >= MIN_DEFICIT)
    .sort((a, b) => b.impressions - a.impressions);
}

/**
 * Pages whose FAQ could answer what people ask: `bySlug` from `ownQueriesBySlug`. Excluded, cooldown
 * and skipped pages are left out. Each pick is `{ slug, kind: 'faq', score, reason, questions, queries }`,
 * `score` the impressions of its gap queries. `limit` as in `takePicks`.
 */
export function pickQuestionPage({ bySlug, config = {}, cooldown = new Set(), skip = [], limit }) {
  const excluded = new Set(config.exclude_slugs || []);
  const picks = [...bySlug.values()]
    .filter(p => !cooldown.has(p.slug) && !excluded.has(p.slug) && !skip.includes(p.slug))
    .map(p => ({ page: p, gaps: questionGaps(p.queries) }))
    .map(({ page, gaps }) => ({ page, gaps, score: gaps.reduce((sum, q) => sum + q.impressions, 0) }))
    .filter(({ score }) => score >= MIN_PAGE_IMPRESSIONS)
    .sort((a, b) => b.score - a.score)
    .map(({ page, gaps, score }) => {
      const questions = gaps.slice(0, MAX_QUESTIONS);
      const count = (kind) => gaps.filter(q => q.kind === kind).length;
      return {
        slug: page.slug,
        kind: 'faq',
        score,
        reason: `${count('question')} Fragen- und ${count('purchase')} Kaufabsicht-Suchen mit ${score} Impressionen und zu wenig Klicks`,
        questions,
        queries: [...page.queries].sort((a, b) => b.impressions - a.impressions).slice(0, 15),
        impressions: page.impressions,
        clicks: page.clicks,
        bestPosition: page.bestPosition,
      };
    });
  return takePicks(picks, limit);
}
