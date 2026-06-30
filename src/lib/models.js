// Single source of truth for the Claude model ids used across the pipeline.
// Bump here, not at the call sites, so generation and scoring never drift apart.
export const MODELS = Object.freeze({
  generate: 'claude-opus-4-7', // full page generation (generate.js, 8000 tokens)
  default: 'claude-sonnet-5', // scoring, greenfield, site analysis (claude.js default)
});
