# Full Audit — 2026-05-15

**Scope:** entire codebase (26 source files, ~1800 lines), Node.js 22 ESM CLI.
**Mode:** SINGLE batch, 3 rounds (R1 audit+fix, R2 audit+fix, R3 fix-only).
**Subagents active per round:** Architecture, Security, Performance, Code Quality (agents 5-10 skipped — no frontend / translation files).

## Summary

- 1 Critical, 18 Important, ~7 Minor fixed across 3 rounds.
- 0 new files. All changes surgical.
- Convergence: Round 1 = 22 Critical+Important, Round 2 = 4 Important (3 regressions), Round 3 = 0.

## Critical (fixed)

| File | Issue | Fix |
|---|---|---|
| `src/steps/generate.js:25-42` | Double-substitution prompt-injection: LLM-controlled fields (`type`, `intent`, `expected_entities`, `content_gaps`) inserted via chained `.replace('{{key}}', val)`. If Claude returned `{{validator_feedback}}` in any field, the next `.replace` expanded it, injecting attacker text into the retry prompt. | Single-pass `template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? match)`. Each `{{key}}` resolved exactly once from a lookup table; substituted content is never re-scanned. |

## Important (fixed)

| File | Issue |
|---|---|
| `src/steps/discover.js:25-32` | DONE-detection compared `kw.target_slug` against `getExistingTitles` (which returns headlines OR filenames). Slug match rarely fired, pages stuck on `pr_opened`. Switched to `getExistingSlugs`. |
| `src/steps/discover.js:157-169` | Greenfield `target_slug` from Claude stored without `^[a-z0-9][a-z0-9-]*$` validation, allowing bad slugs to persist in `keywords.json` and trigger path-shaped reads in `run.js`. Added regex guard before `upsertKeyword` in both `scoreAndSave` and `discoverGreenfield`. |
| `src/steps/discover.js:146-170` | Sequential SerpAPI loop in greenfield mode (~10s wasted on 5-10 keywords). Parallelized via `Promise.all`. |
| `src/steps/pr.js:78-83` | `mdCell()` did not escape `[` / `]`. GSC keyword like `[Click here](https://phishing.example.com)` rendered as live link in PR body. Added bracket escaping. |
| `src/steps/pr.js:86-114` | `seoCheck` parsed frontmatter with per-field regex (`getField`) — broke on quoted/multi-line YAML values, and the interpolated key was not regex-escaped. Switched to `yaml.load(fm)` and read keys from the parsed object. |
| `src/steps/pr.js:8` | `SITEMAP_PENDING_FILE` defined as local constant; `KEYWORDS_FILE` imported from lib. Inconsistent. Added `SITEMAP_PENDING_FILE` export to `lib/keywords.js` and imported it. |
| `src/steps/validate.js:17-19` | `fm.includes('field:')` substring match: `target_slug: x` satisfied `fm.includes('slug:')`. Used `yaml.load(fm)` once, then `field in parsed` for exact-key check. |
| `src/steps/validate.js:21-43, 81-86` | meta_title, meta_description, hero.headline, tldr, faq checks used regex against raw FM. Switched to values from `parsed` object — consistent with the load step. |
| `src/commands/run.js:113-115` | Dynamic `await import('fs')` inside hot path. Promoted to static `import { writeFileSync, mkdirSync } from 'fs'`. Then refactored to use the new `saveLastPR` helper from `lib/keywords.js`, leaving only `existsSync` in the import. |
| `src/commands/run.js:20-21 vs 59-62` | Two different `landingPath` derivations: one used the configured default locale, the other hardcoded `de\|en`. Diverged when `defaultLocale` was anything else. Deleted the second derivation; reused `localeLandingPath` already in scope. |
| `src/commands/run.js:19-65` | `generateForLocale` returned `boolean` AND mutated `generatedPages` via push. Mixed-return-with-side-effect. Function now returns `null` or the page object; caller pushes and passes a `Set` of `slug::locale` keys for collision detection. |
| `src/lib/keywords.js` | Added `SITEMAP_PENDING_FILE`, `LAST_PR_FILE` exports and `saveLastPR(prUrl, cwd)` helper to keep state file paths in one place. |
| `src/lib/gsc.js:8`, `src/lib/serpapi.js:5` | `join(process.env.HOME, ...)` at module load throws `TypeError` if `HOME` unset (some CI/Docker setups). Switched to `os.homedir()`. |
| `src/lib/gsc.js:36` | `credentials.installed \|\| credentials.web` destructured without existence check — cryptic `Cannot destructure property 'client_secret' of undefined` on malformed JSON. Added explicit guard with descriptive error. |
| `src/lib/gsc.js:95-130` | `querySearchAnalytics` and `queryPagePerformance` both hit GSC per call; no run-lifetime cache. Added a module-scope `gscCache` Map keyed by `{property, dimensions, days, lag, rowLimit}`. Both public functions delegate to a shared `gscQuery` helper. |
| `src/lib/serpapi.js:8-11` | `loadQuota` read disk on every `getSerp` + every `checkQuota` call. Added `quotaCache` at module scope; `loadQuota` short-circuits after first read, `saveQuota` writes through to disk + cache. |
| `src/lib/serpapi.js:44` | Bare `fetch()` bypassed `safeFetch` SSRF guard. Switched to `safeFetch` for consistency. |
| `src/lib/serpapi.js:33-54` | In-process quota race: parallel `getSerp` calls (now triggered by the greenfield `Promise.all`) all read the same `quota.used` and bumped from the same base — counter incremented by 1 instead of N. Reservation pattern: `bumpQuota` BEFORE the HTTP call, `rollbackQuota` on failure (only rolls back if no later writer overtook). |
| `src/lib/landings.js:33-50` | `getExistingTitles` called in `discover` and again in `discoverGreenfield` per run, doing 2× `readdirSync` + N × `readFileSync`. Added `titlesCache` Map (same pattern as `slugsCache`). |

## Minor (fixed)

| File | Change |
|---|---|
| `src/lib/claude.js:13-42` | Linear backoff (`attempt * 15000`) replaced with exponential + jitter (`min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS) + random(0..1000)`). Magic numbers extracted to named constants. |
| `src/lib/github.js:4-7` | `getOctokit` now memoizes the `Octokit` instance instead of constructing a new one per call. |
| `src/lib/config.js:20-29` | `base_url: ''` and `site_name: ''` removed from `DEFAULTS` — never read from the object, only set inline in `init.js`. |

## Open-points wave (user-confirmed, fixed in same audit)

After the initial loop, the user opted to implement all 11 open points in the same audit. Wave A created 3 new utility files; Wave B+C ran 8 parallel agents to consume the utilities and apply the remaining fixes. All implemented without new npm dependencies.

| # | Change | Files |
|---|---|---|
| 1 | New `lib/frontmatter.js` (parseFrontmatter, splitFrontmatter via js-yaml). Callers: validate.js, pr.js#seoCheck, landings.js#getExistingTitles | `src/lib/frontmatter.js` (new), `src/steps/validate.js`, `src/steps/pr.js`, `src/lib/landings.js` |
| 2 | New `lib/template.js` (fillTemplate single-pass `{{key}}` substitution). Callers: generate.js, discover.js (buildScorePrompt + greenfield) | `src/lib/template.js` (new), `src/steps/generate.js`, `src/steps/discover.js` |
| 3 | New `lib/site-fetch.js` (fetchPages parallel + shared stripHtml). Callers: analyze-site.js, generate-style-doc.js | `src/lib/site-fetch.js` (new), `src/lib/analyze-site.js`, `src/lib/generate-style-doc.js` |
| 4 | Parallel generate-loop with inline 16-line `pLimit` helper (no new dep). Concurrency cap = 2 to respect Anthropic rate limits. Shared `generatedKeysAtomic` Set for collision detection across tasks. | `src/commands/run.js` |
| 5 | Domain validation: detect.js now rejects URLs whose host has no dot or whose TLD is `localhost`/`internal`/`corp`/`lan`/`local`/`home`/`test`/`example`/`invalid`. Falls through to next match. | `src/lib/detect.js` |
| 6 | Inquirer `locales` default fixed: choices extracted to a variable, default is now the matching choice's index (or 0). | `src/commands/init.js` |
| 7 | CSV size guard: 5MB soft cap, logs warning and skips write instead of corrupting the file. Manual rotation expected. | `src/steps/track.js` |
| 8 | `discoverGreenfield` now reuses `buildKeywordEntry` (signature changed to params-object accepting optional `gsc` field) instead of building the keyword shape manually. | `src/steps/discover.js` |
| 9 | `pr.js`: locale-slug logic extracted to `localeSlug(slug, locale, locales)` and reused in both `createPR` and `injectHreflang`. | `src/steps/pr.js` |
| 10 | Workflow `Report PR URL`: replaced `require('./seo/last-pr.json')` with `fs.readFileSync` + `JSON.parse`. | `.github/workflows/seo-reusable.yml` |

### Not implemented (with justification)

- **SerpAPI cross-process TOCTOU** (cron + manual on same machine): the in-process race is fixed via the reservation pattern (Round 3). Cross-process locking would require `proper-lockfile` (~13kB dep tree). Real-world risk is very low (two SerpAPI runs on the same machine in the same second). Not worth the dependency.

## Suppressions
None added.

## Manual test plan
No frontend / visually-relevant files. Smoke-test: `node bin/seo.js --help` returns the expected commander output. Full end-to-end run requires API keys and a configured project (out of scope for this audit).

End-to-end checks the user should do once before next push:
- Run `seo init` in a fresh project — confirm the inquirer default for `locales` now highlights correctly.
- Run `seo run --dry-run` against a real config — confirm `discover` still discovers, the new `fillTemplate` does not regress the score/generate prompts, and the parallel generate-loop produces the same number of pages.
- Check `seo/keywords.json` after a real run — greenfield entries should now have the same shape as GSC entries (minus the `gsc` field).
