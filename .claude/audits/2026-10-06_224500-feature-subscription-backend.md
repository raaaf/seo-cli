# Audit: 2026-10-06: Branch: feature/subscription-backend

## Scope
- Base: ced305e0d49f13e897205eae25d04a2d1c6d3433 | HEAD at audit time: 6d0faaa (fixes committed as 6b4e776)
- Changed files: 13 | Diff class: code
- Reviews run: code_review

## Pre-checks
- check-ci-hardening: HITS (4), actions pinned to tags in seo-reusable.yml (pre-existing, lines shifted by this diff)
- check-docs-claims: FINDINGS (1), CLAUDE.md:25 placeholder path

## Result
- Gate: passed
- Findings: Critical 0 / Important 4 / Minor 6 | Fixed 5 | Discarded 5 | Open 0
- Tests: npm test, 42 files, 448 tests passed
- Kosten dieses Laufs: 1.77 USD (ca. 0.1 % der Woche), Woche ca. 121.9 % (lokale Schätzung über die Sessions auf diesem Mac; genauer Wert: /usage)

## Findings
- [Important][code_review] src/lib/claude-code.js:54: output concatenated per Buffer chunk, split multi-byte characters corrupt generated text
- [Important][code_review] src/lib/claude.js:231: missing or malformed JSON from the subscription rethrown instead of falling back
- [Important][code_review] src/lib/claude.js:224: API fallback inside the window could wait on a 45-minute batch
- [Important][code_review] src/lib/claude-code.js:105: max_tokens and refusal fell back to a paid API call that fails the same way
- [Minor][code_review] src/lib/claude.js:240: claudeOnPath rescanned PATH on every call
- [Minor][code_review] src/lib/claude.js:232: one timeout switches every model to the API
- [Minor][code_review] src/lib/claude-code.js:35: error classification by free-text regex
- [Minor][code_review] src/commands/run.js:422: report.llm only written by seo run
- [Minor][pre-check] .github/workflows/seo-reusable.yml:63: actions pinned to tags, not SHAs
- [Minor][pre-check] CLAUDE.md:25: docs claim references placeholder path

## Fixed
- [Important][code_review] src/lib/claude-code.js:54: stdout and stderr decoded as utf-8, test with a split umlaut
- [Important][code_review] src/lib/claude.js:231: JSON extraction failure becomes a per-call fallback, booking stays fail-closed
- [Important][code_review] src/lib/claude.js:224: batch disabled for every fallback after a subscription attempt
- [Important][code_review] src/lib/claude-code.js:105: truncated or refused CLI responses throw the API path's errors, no fallback
- [Minor][code_review] src/lib/claude.js:240: PATH lookup cached per process

## Discarded
- [Minor][code_review] src/lib/claude.js:232: plan decision, a hanging CLI affects every call
- [Minor][code_review] src/lib/claude-code.js:35: classification only runs on error output (is_error or non-zero exit), not on model content
- [Minor][code_review] src/commands/run.js:422: the workflow only uses seo run --report
- [Minor][pre-check] .github/workflows/seo-reusable.yml:63: predates this branch
- [Minor][pre-check] CLAUDE.md:25: intentional placeholder

## Minor, not fixed

## Not completed

## Open Points
