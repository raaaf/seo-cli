# Full Audit — 2026-06-11

- **Scope:** 11/11 dimensions selected (architecture, security, performance, code_quality, seo, a11y, typography, ui_design, ux, animation, docs_sync). Dimensions 5-10 (seo, a11y, typography, ui_design, ux, animation) had **no targets** — pure Node ESM CLI, zero frontend/template-view files — so they ran empty. Effective dimensions: architecture, security, performance, code_quality, docs_sync.
- **Mode:** SINGLE (32 files: 28 JS + 4 prompt templates). 2 rounds (Round 1 find+fix, Round 2 adversarial verify+cross-ref). Converged: 0 new Critical/Important in Round 2.
- **Effort:** xhigh (fix minors, forced cross-ref).
- **Result:** 2 Critical, 9 Important, 6 Minor found and fixed. 0 hard-blockers remain.

## Files changed (14 edited, 1 new)

safe-fetch.js, template.js, analyze-site.js, generate-style-doc.js, gsc.js, config.js, landings.js, run.js, discover.js, validate.js, pr.js, dashboard.js, generate.md, + new `src/lib/seo-thresholds.js`.

## Critical (fixed)

1. **SSRF redirect bypass** — `src/lib/safe-fetch.js:50`. `safeFetch` validated only the initial URL; Node `fetch` follows redirects by default, so a public host could 302 → `169.254.169.254`/internal IP unchecked. Fixed: `redirect:'manual'` + re-run `assertPublicUrl` on every hop, max 5.
2. **Indirect prompt injection via unstripped fence markers** — `src/lib/template.js`, `analyze-site.js`, `generate-style-doc.js`. Untrusted SERP titles/snippets and fetched site copy were embedded inside `<<<UNTRUSTED_*>>>` blocks without stripping the marker tokens; a crafted value containing `<<<UNTRUSTED_SERP_END>>>` broke out of the data block. Fixed: centralized `sanitizeUntrusted()` in template.js (strips runs of 3+ `<`/`>`), applied in `fillTemplate` to every substituted value + explicitly at the two literal-template sites.

## Important (fixed)

3. **LLM-derived fields in trusted prompt section** — `src/prompts/generate.md`. `type`/`intent`/`geo_scope`/`expected_entities` (derived from SERP-influenced scoring output) sat in the trusted Context block. Moved into a `<<<UNTRUSTED_DERIVED_*>>>` fence.
4. **OAuth loopback without CSRF state** — `src/lib/gsc.js:68`. Added random `state`, verified on redirect before resolving the code.
5. **loadConfig ignored DEFAULTS** — `src/lib/config.js`. `loadConfig` returned raw YAML, so `score_cutoff`/`weekly_cap`/`min_impressions` were `undefined` when omitted (run.js used `weekly_cap` with no fallback → `slice(0, undefined)` = generate everything). Fixed: merge `{ ...DEFAULTS, ...yaml }`.
6. **Greenfield score ignored configured cutoff** — `src/steps/discover.js:215`. `score: kw.score ?? 7` hardcoded the default; a scoreless greenfield keyword on a project with `score_cutoff > 7` was SKIPped, defeating the greenfield top-up. Fixed: `?? config.score_cutoff`.
7. **Locale-path logic duplicated 2×** — `run.js` + `landings.js`. Extracted `defaultLocale(config)` + `localeLandingPath(config, locale)` into config.js; both callers migrated.
8. **`extractMainCopy` reimplemented `stripHtml`** — `generate-style-doc.js`. Deleted; now uses the pre-stripped `.text` from `fetchPages` (matches analyze-site.js).
9. **SEO thresholds duplicated + divergent** — `validate.js` vs `pr.js seoCheck`. Extracted shared `src/lib/seo-thresholds.js`; both consume it. All original numbers preserved exactly (verified).
10. **fabricated-claim regex array rebuilt per call** — `validate.js`. Hoisted to module-scope `FABRICATED_PATTERNS`.
11. **dashboard re-read all ranking CSVs per project** — `src/lib/dashboard.js`. Added run-scoped memo Map keyed by ranking dir.

## Minor (fixed)

- `discover.js`: magic `20`/`10` → `MAX_GSC_CANDIDATES` / `MAX_SCORED_PER_RUN`.
- `validate.js`: stripped project-specific "events app" reference from comment + error string.
- `analyze-site.js`: removed unused `stripHtml` import.
- `dashboard.js`: named position-window magics (`NEAR_PAGE1_MIN/MAX_POSITION`).
- (template.js sanitize + generate.md fence also close the minor "markers not stripped" sub-findings.)

## Discarded (hallucinated / wrong)

- code-quality: "path-traversal guard runs after mkdirSync" in generate-style-doc.js — **false**, guard is before mkdirSync.
- docs-sync: ".env.example not committed" — **false**, it is git-tracked.

## Acknowledged, NOT fixed (with rationale)

- **`discover.js scoreAndSave` sequential loop** (performance flagged Critical): the sequential per-candidate loop with early-exit (`scored >= MAX_SCORED_PER_RUN break`) is **intentional SerpAPI-quota cost control** (hard cap 240/week). Parallelizing would issue all SerpAPI+Claude calls upfront, defeating the early-exit and risking quota. Left as-is by design.
- `init.js` fetches overlapping URLs twice (analyzeSite + generateStyleDoc): one-time interactive command, 3-page overlap, negligible. Not worth a shared-fetch refactor.
- Redundant `?? 5`/`?? 2` fallbacks after the DEFAULTS merge: harmless belt-and-suspenders, left for minimal diff.
- `gscCache` unbounded: non-issue for a short-lived CLI process.

## Open points (actionable)

- **`.env.example` missing `SEO_PROJECT_ROOTS`** (docs, Important): referenced in `projects.js` and documented in README/CLAUDE.md, absent from `.env.example`. Could not edit — environment guards `.env*` paths. Add manually:
  ```
  # Optional: colon-separated roots the cross-project dashboard scans for seo.config.yaml
  # (defaults to ~/Local Sites). Example: /Users/you/Sites:/Users/you/work
  # SEO_PROJECT_ROOTS=
  ```

## Gaps

- **No test runner** (no vitest/jest/node:test/phpunit/pytest). Streak tracking started this run (`.claude/audits/no-test-runner-streak` = 1); escalates to a Critical finding after 3 consecutive full-audits without one. Verification this run relied on `node --check`, ESM import smoke tests, the CLI `--help` module-tree load, and targeted behavioral assertions (template substitution/sanitize/single-pass, locale helpers, threshold parity, validate pass/fail).

## Manual test plan (no frontend; verify the pipeline against a real target project)

1. In a target project with `seo.config.yaml` + API keys: `node bin/seo.js run --dry-run` — confirm discover→generate→validate runs and previews markdown without committing.
2. Set `score_cutoff: 9` in a GSC-poor project, run `--dry-run` — confirm greenfield keywords are now PROPOSED (not silently skipped) thanks to fix #6.
3. `node bin/seo.js dashboard` then immediately again — confirm identical output and no errors (rankingStats memo, fix #11).
4. `node bin/seo.js dashboard --live` if GSC token valid — confirm live positions load.
5. (Optional, OAuth) delete `~/.seo-cli-token.json`, run a GSC command — confirm browser auth still completes and a tampered `state` would be rejected.

## Notes

- The 4 open learning-log suggestions were implemented against the global skill files (`~/.claude/skills/audit`, `~/.claude/skills/full-audit`) but those files are under an external sync that overwrote the edits (a newer canonical skill version was pulled in mid-session). Marked `[skip]` in learning-log.md; the diffs must be applied in the upstream skill repository. See learning-log.md note.
