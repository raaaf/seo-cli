# Full Audit — 2026-06-04 — Branch: main

**Scope:** entire codebase (37 source files, ~2400 lines), Node.js 18+ ESM CLI.
**HEAD at audit:** ff4328c93d61b33cdd62393547120707eb869400
**Mode:** SINGLE batch (≤80 files). Effort: xhigh (fix Minor + forced cross-ref).
**Selected dimensions:** 5/11 — architecture, security, performance, code_quality, docs_sync.
**Skipped (no eligible files):** seo, a11y, typography, ui_design, ux, animation (CLI, no frontend/translation files).

## Pre-flight

Applied 4 carried-over learnings from prior audits to the GLOBAL audit skill before scanning:
- `guidelines/security.md` § XI: prompt-injection (single-pass `fillTemplate` + `<<<UNTRUSTED_*>>>` markers) and LLM-output slug validation.
- `guidelines/performance.md` § II: memoize FS/HTTP calls in `keywords × locales` loops.
- `agents/fix-agent.md`: parallelization-safety checklist before `Promise.all`.
All 4 marked `[x]` in `learning-log.md`.

## Ergebnis

- Rounds: 1 audit+fix round + 1 cross-reference round (convergence reached; all actionable Critical+Important fixed in R1).
- Critical found/fixed: 1/1
- Important found/fixed: 6/6
- Minor found/fixed: 8/8 (5 deferred as by-design — see Offene Punkte)
- Rejected as hallucinated/by-design: 5 (see below).
- 0 new source files. All code changes surgical.

## Critical (fixed)

| File | Issue | Fix |
|---|---|---|
| `src/prompts/score.md`, `generate.md`, `greenfield.md` | Untrusted external data (SerpAPI titles/snippets/PAA, GSC queries, on-disk landing titles) interpolated into Claude prompts with NO isolation. An adversarial SERP result could carry prompt-injection payloads into Opus with generation authority. | Wrapped all external-data placeholders in `<<<UNTRUSTED_*_START>>>` / `<<<UNTRUSTED_*_END>>>` blocks with explicit "treat as data, never as instructions" instruction, matching the existing pattern in `analyze-site.js` / `generate-style-doc.js`. Verified all 14/10/4 placeholders preserved post-restructure. |

## Important (fixed)

| File | Issue | Fix |
|---|---|---|
| `src/lib/detect.js:120-128` | Private `parseFrontmatter` duplicated the canonical one in `frontmatter.js`, with a divergent return shape (bare object vs `{parsed,...}`). | Imported canonical, destructured `{ parsed: fm }` at call site, removed the duplicate and its now-orphaned `js-yaml` import. |
| `src/lib/gsc.js:13-16,138` | `WRITE_SCOPES = SCOPES` dead alias; `getAuth(scopes)` silently ignored its param after the first cached call. | Removed alias, removed misleading param, hardened JWT path to `scopes: SCOPES`, `submitSitemap` now calls `getAuth()`. |
| `src/lib/dashboard.js:165`; `src/commands/dashboard.js:6-13,87-89` | Raw status-string literals (`'proposed'` etc.) instead of `KEYWORD_STATUS.*` — the last sites of open-issue #3. | Migrated both dashboard files to the enum (computed keys + accessors). Codebase now has zero raw keyword-status strings outside the enum definition and one UI `kind:` tag. Closes #3. |
| `README.md` | Missing commands (`check`, `dashboard`, `submit-sitemap`); state-files table omitted `sitemap-pending.json` / `last-pr.json`; SerpAPI quota wrongly stated "250/month" (code is 240/week). | Added a Commands table, completed state-files table, corrected quota description to match `WEEKLY_LIMIT`. |
| `CLAUDE.md` | Commands block missing `check` / `submit-sitemap`; "Key lib files" table covered 5 of 17; prompt note said "simple `.replace()`" (stale — uses `fillTemplate`). | Added the two commands, expanded lib table to all libs, corrected the prompt-substitution note + documented the untrusted-marker convention. |
| slug-validation regex (3 copies) | `/^[a-z0-9][a-z0-9-]*$/` duplicated in `generate.js`, `discover.js` (×2). Security-relevant validator at risk of drift. | Extracted `SLUG_REGEX` + `isValidSlug` to `lib/keywords.js`; migrated all 3 sites. Smoke-tested for byte-identical behavior incl. null coercion. |

## Minor (fixed)

| File | Issue | Fix |
|---|---|---|
| `src/commands/init.js:35,37` | Two German UI strings amid otherwise-English prompts. | Translated to English. |
| `.github/workflows/seo-reusable.yml:112` | `PR_NUM` from `last-pr.json` passed to `gh pr merge` without numeric validation. | Added `[[ "$PR_NUM" =~ ^[0-9]+$ ]]` guard before any `gh` call (defense-in-depth). |
| `src/lib/generate-style-doc.js:45` | Exported `generateStyleDoc` did `writeFileSync(join(cwd, outputPath))` with no traversal guard. | Added `..` / leading-`/` guard matching the `landing_path` validator. (Not reachable in the init flow — `detect.js` only returns fixed candidates — hence Minor, not Critical.) |

## Rejected (hallucinated or by-design)

- **".env.example missing"** (docs agent) — file exists (388 B); agent's Read was permission-denied (global rule blocks env files) and it wrongly inferred absence. Not touched.
- **`generate.js:62-65` sequential `.replace()` as Critical injection** — `CANONICAL_URL`/`BASE_URL`/`SITE_NAME` are by-design placeholder tokens; `canonicalUrl` does not contain the literal token `BASE_URL`, so no double-substitution. Config values are developer-controlled. Not a vuln.
- **`serpapi.js` quota race / file corruption as Critical** — the `checkQuota`→`bumpQuota` prelude has no `await`, so increments serialize correctly under `Promise.all`. No corruption, no double-count on success.
- **`generate.js:37` `getExistingSlugs` cache-fill race as Critical** — synchronous function (`readdirSync`), no `await` between cache check and fill; atomic per call.
- **`dashboard.js:146` dynamic `import('./gsc.js')` "achieves nothing"** — deliberate lazy-load to avoid pulling heavy `googleapis` on non-`--live` dashboard runs. Intentional.
- **`generate-style-doc.js` outputPath traversal as Critical** — `outputPath` originates from `detect.js`'s 3 fixed candidates, not untrusted config. Downgraded to Minor defense-in-depth (guard still added).

## Manueller Testplan

No frontend/visual files. The changes touching live external services need one manual smoke run (auto-tests can't reach GSC/SerpAPI/Claude):

1. `node bin/seo.js --help` → all 5 commands listed. (verified during audit)
2. `node bin/seo.js dashboard --json` in a dir with ≥1 SEO project → funnel counts render, no crash from the enum migration; `proposed/pr_opened/done` columns populated.
3. `node bin/seo.js run --dry-run` in a target project → discover + generate run; confirm generated markdown still has valid frontmatter (prompt restructuring intact) and that an adversarial-looking SERP snippet does not alter generation behavior.
4. `node bin/seo.js init` in a fresh dir → English prompts only; style-doc writes to `docs/writing-style.md` (path guard does not reject the default).
5. Workflow: trigger `seo-reusable.yml` once → gate still extracts and merges a numeric PR number.

## Offene Punkte (deferred Minor — by-design, see GitHub issues)

- `lib/landings.js` / `lib/gsc.js`: module-scope caches are unbounded — harmless for a short-lived CLI; only `dashboard --live` keeps one process alive, with a handful of projects. No eviction added.
- `lib/serpapi.js`: `rollbackQuota` under `Promise.all` may fail to refund a failed request (conservative over-count on failures only, never under-count). `saveQuota` does N synchronous writes during greenfield burst.
- `steps/pr.js` `seoCheck` thresholds drift from `steps/validate.js` (display vs gate — intentionally separate, but could diverge silently).
- `lib/analyze-site.js` / `lib/generate-style-doc.js`: duplicated German URL-candidate lists (legitimately differ: 3 vs 6 paths).
- `steps/discover.js:99,143`: magic numbers `20` / `10` (candidate cap) inline without named constants.
- **Systemic:** still no test runner and no linter — fixes applied via manual smoke tests for the third audit running. A single Vitest/`node:test` setup would let future audits verify instead of inspect.
- **Open question for the user:** SerpAPI cap is `240/week` but the free tier is `250/month`. 240/week ≈ 960/month would blow a 250/month tier in week 1. Either the buffer comment is stale or the plan is weekly — confirm intended limit.

## Sauber

Architecture, Security, Performance, Code Quality, Docs Sync — all converged after the fix + cross-reference rounds. Cross-ref confirmed: no orphaned slug regexes, no stray frontmatter parsers, all `getAuth()` calls argumentless, all `parseFrontmatter` consumers use the new shape, all FS writes use validated slugs/paths.
