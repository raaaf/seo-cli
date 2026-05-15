# Audit Learning Log

This log is automatically appended after each audit.

---

## Retro — 2026-05-13 — main (full-audit)

### Statistik
- First audit in this project — no pattern recognition possible yet.

### Baseline
- Critical: 5, Important: 17, Minor: 11 (all fixed across 2 rounds).
- Skipped dimensions (no eligible files): SEO, A11y, Typography, UI Design, UX, Animation.
- Active dimensions: Architecture, Security, Performance, Code Quality.

### Worth remembering (for future audits in this codebase)

- **Untrusted-content injection into LLM prompts** appeared 3 times (analyze-site, generate-style-doc, discover). Fix pattern: `<<<UNTRUSTED_X_START>>>` markers + explicit "treat as data" instruction. Watch any new prompt assembly.
- **Memoization gaps in CLI hot loops** (loadStyleDoc, getExistingSlugs, defaultLocale, dynamic imports). Cost scales with `keywords × locales`. Always question per-iteration FS access.
- **GitHub Actions secrets via `echo`** is unsafe whenever the secret can contain `\n`, `"`, or `'`. Use `env:` mapping + `printf` with `umask 077`.
- **Stringly-typed status enum** (`proposed | done | skip | pr_opened | validation_failed`) is scattered across 3 files. Tracked as open issue #3.

### Open points carried forward
Issues #1-#7 on github.com/raaaf/seo-cli. Re-check at next audit whether they were closed or rotted.

### Gaps that limit audit quality
- No test runner configured → fixes applied blind. Add Vitest or Node's built-in `node:test` before next audit.
- No linter → can't catch the simple things automatically.

---

## Retro — 2026-05-15 — main (full-audit)

### Statistik
- Audits insgesamt im Projekt: 2
- Haeufigste Finding-Kategorie: Memoization/caching gaps (8 individual instances across both audits)
- Findings 2026-05-13: 5 Critical + 17 Important + 11 Minor = 33
- Findings 2026-05-15: 1 Critical + 18 Important + ~7 Minor = ~26
- Durchschnittliche Findings pro Audit: ~30

### Was lief gut
- Convergence improved: May 13 needed 2 rounds, May 15 converged fully in 3 rounds including 11 open-points in the same session.
- 3 new shared utility files extracted (`lib/frontmatter.js`, `lib/template.js`, `lib/site-fetch.js`) — the DRY finding from May 13 (#4: landing-dir enumeration) was addressed structurally, not just patched.
- The `fillTemplate` single-pass substitution closes the entire double-substitution class of prompt injection permanently, not just for one call site.
- SerpAPI in-process quota race detected and fixed in the same audit that introduced parallel calls (greenfield `Promise.all`). No regression window left open.

### Was lief schlecht
- 3 regressions appeared in Round 2 (re-auditing code touched in Round 1). Suggests fix-agents in R1 were not given enough context about related invariants (e.g., parallelizing serpapi calls without updating the quota-bump logic first).
- Stringly-typed status enum (open point #3 from May 13) still not addressed. Two audits, no action. Candidate for suppression or a dedicated refactor issue.
- `SITEMAP_PENDING_FILE` was duplicated in `pr.js` as a local constant — this was also flagged in May 13 (`pr.js:26-30`). The fix in May 13 imported `KEYWORDS_FILE` but left `SITEMAP_PENDING_FILE` as a local. The May 15 audit caught this again. Partial fixes that leave related constants unresolved are a recurrence risk.

### Was hat gefehlt
- Still no test runner. Fixes are applied blind for the second time. A single failing test would have caught the DONE-detection slug-vs-title mismatch (`discover.js:25-32`) before it persisted two audits.
- No linter. Simple issues like unused variables and duplicate constants still surface only via subagent review.
- Cross-process quota locking deliberately deferred (dep cost). The decision is documented but not tracked as a known limitation anywhere in the codebase.

### Erkannte Patterns
- **Prompt injection / template substitution**: seen in both audits. May 13: raw keyword + HTML in prompts; May 15: double-pass `{{key}}` substitution. Any new function that builds a Claude prompt from external data is high-risk. (2 audits)
- **Memoization gaps in module-level state**: seen in both audits. May 13: loadStyleDoc, getExistingSlugs, gsc auth, serpapi quota. May 15: gscCache, quotaCache, titlesCache, Octokit instance. Pattern: every FS or HTTP call inside a loop that runs N×M times (keywords × locales). (2 audits)
- **Slug/path injection from LLM output**: seen in both audits. May 13: `target_slug` in `generate.js`. May 15: `target_slug` in `discover.js` (greenfield path). Any place Claude returns a filename or path must be validated with `/^[a-z0-9][a-z0-9-]*$/`. (2 audits)
- **Partial constant centralisation**: May 13 moved `KEYWORDS_FILE` to lib but left `SITEMAP_PENDING_FILE` as a local. May 15 caught the leftover. When moving one constant to a central module, audit all related constants in the same file at the same time.
- **Parallelisation introducing new races**: May 15 greenfield `Promise.all` exposed the in-process quota race that the May 13 sequential loop hid. When adding `Promise.all` to any loop that writes shared state, review all writers.

### Vorgeschlagene Verbesserungen
- [ ] `guidelines/security.md` (or new `guidelines/prompt-injection.md`): Add rule — any new function that interpolates external data into a Claude prompt must use `lib/template.js#fillTemplate` (single-pass) and wrap untrusted blocks in `<<<UNTRUSTED_*>>>` markers.
- [ ] `guidelines/performance.md`: Add rule — any FS or HTTP call inside a loop over `keywords × locales` must be memoized at module scope before the loop. Standard pattern: `const cache = new Map(); if (cache.has(key)) return cache.get(key);`.
- [ ] `guidelines/security.md`: Add rule — any slug/path value returned by an LLM must be validated with `/^[a-z0-9][a-z0-9-]*$/` before any FS operation.
- [ ] Audit orchestrator prompt: Add explicit instruction — when parallelising a sequential loop, the fix-agent must review all shared mutable state touched by the loop body before applying `Promise.all`.
