// Single source of truth for the Claude model ids used across the pipeline.
// Bump here, not at the call sites, so generation and scoring never drift apart.
export const MODELS = Object.freeze({
  generate: 'claude-opus-5-5', // page generation, improve rewrites, counterpart adaptation, fact check
  default: 'claude-sonnet-5-5', // scoring, greenfield, site analysis (claude.js default)
});

// Adaptive thinking is always on whenever the model is MODELS.generate (see
// claude.js#complete; Opus 5.5 cannot disable it), and thinking tokens count
// against max_tokens. A finished page is ~6-8k tokens of markdown; 8000 left
// no room for thinking and every generate/improve/counterpart/review call
// hit the cap on 2026-09-23, truncating pages and crashing improve outright.
export const GENERATE_MAX_TOKENS = 32000;

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-10-06). `cacheWrite` is the 5-minute write price, the only one
// the pipeline uses (system prompt cache_control: ephemeral).
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
});

// The Message Batches API takes half off every token price, caches included.
export const BATCH_DISCOUNT = 0.5;

// Server-side web_search is billed per request on top of the tokens.
export const WEB_SEARCH_USD = 0.01;
