// Single source of truth for the Claude model ids used across the pipeline.
// Bump here, not at the call sites, so generation and scoring never drift apart.
export const MODELS = Object.freeze({
  generate: 'claude-opus-5', // full page generation (generate.js)
  default: 'claude-sonnet-5', // scoring, greenfield, site analysis (claude.js default)
});

// Adaptive thinking is on by default whenever the model is MODELS.generate
// (see claude.js#complete), and on Opus 5 thinking tokens count against
// max_tokens. A finished page is ~6-8k tokens of markdown; 8000 left no room
// for thinking and every generate/improve/counterpart/review call hit the
// cap on 2026-09-23, truncating pages and crashing improve outright.
export const GENERATE_MAX_TOKENS = 32000;
