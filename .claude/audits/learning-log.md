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
- [x] `guidelines/security.md` (or new `guidelines/prompt-injection.md`): Add rule — any new function that interpolates external data into a Claude prompt must use `lib/template.js#fillTemplate` (single-pass) and wrap untrusted blocks in `<<<UNTRUSTED_*>>>` markers. (applied 2026-06-04: Section XI added to security.md)
- [x] `guidelines/performance.md`: Add rule — any FS or HTTP call inside a loop over `keywords × locales` must be memoized at module scope before the loop. Standard pattern: `const cache = new Map(); if (cache.has(key)) return cache.get(key);`. (applied 2026-06-04: added under Section II)
- [x] `guidelines/security.md`: Add rule — any slug/path value returned by an LLM must be validated with `/^[a-z0-9][a-z0-9-]*$/` before any FS operation. (applied 2026-06-04: Section XI 'Validating LLM output before FS use')
- [x] Audit orchestrator prompt: Add explicit instruction — when parallelising a sequential loop, the fix-agent must review all shared mutable state touched by the loop body before applying `Promise.all`. (applied 2026-06-04: `agents/fix-agent.md` 'Spezial: Parallelisierungs-Fixes' section)

---

## Retro — 2026-06-04 — main (full-audit)

### Statistik
- Audits insgesamt im Projekt: 3
- Haeufigste Finding-Kategorie: Prompt injection / template substitution (3 audits in a row, 7 individual instances total)
- Findings 2026-05-13: 33 (5C + 17I + 11m)
- Findings 2026-05-15: ~26 (1C + 18I + ~7m)
- Findings 2026-06-04: 15 (1C + 6I + 8m), 5 rejected
- Durchschnittliche Findings pro Audit: ~25 (trend: declining, which is correct for a maturing codebase)

### Was lief gut
- All 4 carry-over improvements from the May 15 retro were applied to the global skill before scanning, and their effect was measurable: the prompt-injection finding was caught immediately in R1 with a well-formed fix (prompt markers) rather than needing a separate pattern-discovery pass.
- Open-issue #3 (KEYWORD_STATUS stringly-typed enum) finally closed after two carry-overs. The fix covered the last two stragglers in `dashboard.js` and `commands/dashboard.js`. Codebase now has zero raw status strings outside the enum definition.
- 5 hallucinated/by-design findings correctly rejected with documented rationale. Rejection rate (5/20 = 25%) is higher than prior audits, consistent with the codebase maturing and low-hanging real issues being exhausted.
- CLAUDE.md and README.md brought fully in sync with the actual codebase state (missing commands, stale quota description, incomplete lib table).
- Slug validation centralized to `lib/keywords.js` (`SLUG_REGEX` + `isValidSlug`), closing the slug-drift risk flagged across two prior audits.

### Was lief schlecht
- No test runner for the third consecutive audit. Every fix is applied blind and verified only by manual smoke test. The SerpAPI quota open-question (240/week vs 250/month free tier) cannot be regression-tested automatically.
- Prompt-injection patterns in the three prompt template files (`score.md`, `generate.md`, `greenfield.md`) were missed in both prior audits despite the injection pattern being the most-seen category. The prior audits fixed injection in `.js` callers but did not audit the `.md` templates themselves. Scope assumption gap.
- The `parseFrontmatter` duplication (`detect.js` vs `frontmatter.js`) was introduced as part of the May 15 wave that created `lib/frontmatter.js`. The May 15 audit created the canonical module and migrated callers, but did not catch that `detect.js` was a non-migrated caller. Partial migration recurrence (same pattern as the `SITEMAP_PENDING_FILE` leftover from May 13 to May 15).

### Was hat gefehlt
- Still no test runner and no linter (third consecutive audit). GitHub issue #15 filed but no action. Without it, regressions from the parallelization or enum migration can only be caught manually.
- No audit of `.md` prompt templates as a scope category. All three audits reviewed `.js` files for injection; none explicitly scoped the prompt template files until the June 4 run (and only because the carried-over security guideline forced it). The templates are user-facing LLM inputs and should be a first-class audit target.

### Erkannte Patterns
- **Prompt injection across all three layers** (caller JS, prompt template, LLM output): now seen in all 3 audits. May 13: raw data in caller. May 15: double-pass substitution in caller. June 4: untrusted placeholders in template files themselves. Escalating specificity suggests the fix-then-find cycle is working but each audit uncovers the next deeper layer. (3 audits)
- **Partial migration on DRY refactors**: May 13 left `SITEMAP_PENDING_FILE` un-centralised after moving `KEYWORDS_FILE`. May 15 left `detect.js` un-migrated after creating `lib/frontmatter.js`. June 4 caught the `detect.js` straggler. When a new shared utility is extracted, fix-agents consistently miss callers in files that were not the primary target of the refactor. (3 audits)
- **No tests / no linter**: flagged as a gap in all 3 retros without any action. Escalate to a blocking concern for the next audit rather than a gap note. (3 audits)
- **Magic numbers / inline constants**: candidate counts `20`/`10` in `discover.js` remain unnamed across 2 audits. Low severity, but recurring. (2 audits)

### Vorgeschlagene Verbesserungen
- [ ] `guidelines/security.md`: Add rule under Section XI — prompt template files (`src/prompts/*.md`) must be audited for untrusted placeholder isolation on every full-audit pass, not only the JS callers. Any `{{placeholder}}` whose value originates from external data (GSC, SerpAPI, LLM output) must be preceded by a `<<<UNTRUSTED_*_START>>>` block in the template itself.
- [ ] Audit orchestrator prompt (or `agents/fix-agent.md`): Add instruction — when a new shared utility is extracted (new `lib/*.js`), the fix-agent must grep all files in `src/` for the pattern being centralised and migrate every occurrence, not only the files named in the finding. Explicitly list the grep command to run.
- [ ] Audit orchestrator pre-flight: Add a hard check — if no `vitest`, `jest`, `node:test`, or `mocha` is configured in `package.json` after 3 consecutive full-audits, escalate to a Critical finding in the next audit rather than a gap note. This unblocks automated regression verification for all future fix-agents.
- [ ] Audit scope definition: Explicitly add `src/prompts/*.md` as a Security-dimension audit target (alongside `.js` files) so template files are never skipped in the initial file-selection pass.
