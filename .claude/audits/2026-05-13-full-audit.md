# Full Audit — 2026-05-13

**Scope:** entire codebase (25 files, ~1500 lines), Node.js ESM CLI.
**Mode:** SINGLE batch, 2 rounds.
**Subagents dispatched per round:** Architecture, Security, Performance, Code Quality (agents 5-10 skipped — no frontend / translation files).

## Summary

- 5 Critical, 17 Important, 11 Minor fixed across 2 rounds.
- 1 new file created: `src/lib/safe-fetch.js` (DNS-based SSRF guard).
- 0 deletions of features. All changes are surgical hardening.

## Critical (fixed)

| File | Issue | Fix |
|---|---|---|
| `.github/workflows/seo-reusable.yml:45-49` | Secrets inlined via `echo "X=${{ secrets.X }}"` into `$GITHUB_ENV`. Newline/quote in secret would leak into logs or break parsing. | `env:` mapping + heredoc with `printf '%s\n'`. |
| `.github/workflows/seo-reusable.yml:61-64` | `echo '${{ secrets.GSC_CREDENTIALS }}'` writes JSON via shell-quoted echo. Single quote in secret breaks out. | `env:` mapping + `umask 077` + `printf '%s'`. |
| `src/lib/analyze-site.js:35-49`, `src/lib/generate-style-doc.js:47-71` | SSRF: `fetch(userUrl)` with no host validation. Could hit `169.254.169.254` cloud metadata or RFC1918 ranges. | New `lib/safe-fetch.js` with DNS lookup + private-range rejection; both callers use `safeFetch`. |
| `src/steps/generate.js:11` | `loadStyleDoc` re-reads style file on every `generatePage` call (N keywords × M locales). | Memoized by `cwd::style_doc` key. |
| `src/steps/generate.js:30` | `getExistingSlugs` re-reads landing dir on every `generatePage` call. | Memoized by `cwd::localePath::locale::defaultLocale`. |

## Important (fixed)

| File | Issue |
|---|---|
| `src/lib/gsc.js:11-15, 101-104` | `getAuth()` called separately in `querySearchAnalytics` and `queryPagePerformance`, rebuilding JWT/OAuth each time. Now memoized in module-level `cachedAuth`. |
| `src/lib/gsc.js:39` | OAuth token written without explicit mode. Now `{ mode: 0o600 }`. |
| `src/lib/gsc.js:73` | `exec(\`open "${authUrl}"\`)` — shell interpolation + macOS-only. Now `execFile` with platform-detected opener. |
| `src/lib/gsc.js:58-60` | Accessed private `_clientId` / `_clientSecret` on the Google OAuth client. Now passed in as parameters. |
| `src/lib/claude.js:24-28` | `JSON.parse` of Claude response had no try/catch; SyntaxError killed the retry loop. Now wrapped with a clearer error. |
| `src/lib/analyze-site.js`, `src/lib/generate-style-doc.js` | Prompt injection: fetched page HTML was inlined into the prompt with no isolation. Now wrapped in `<<<UNTRUSTED_CONTENT_START>>>` / `<<<UNTRUSTED_CONTENT_END>>>` markers and Claude is instructed to treat as data. |
| `src/lib/analyze-site.js`, `src/lib/generate-style-doc.js` | Sequential `for (const url ...) await fetch(...)`. Now `Promise.all` (~3× faster on init). |
| `src/steps/discover.js:182-192` | Untrusted GSC keyword interpolated via `.replace('{{keyword}}', keyword)` into a prompt. Now sanitized (strip newlines, slice to 200 chars). |
| `src/steps/discover.js:195-197` | Local `today()` duplicated `lib/date.js#format`. Imported and removed local copy. |
| `src/steps/discover.js:111` | Unused `doneKeywords` parameter in `discoverGreenfield` call. Removed. |
| `src/steps/generate.js` | `target_slug` from Claude could be `../../etc/passwd`. Added `/^[a-z0-9][a-z0-9-]*$/` validation at function entry. |
| `src/steps/pr.js:26-30` | Hardcoded `'seo/keywords.json'` and `'seo/sitemap-pending.json'`. Now imports `KEYWORDS_FILE` from `lib/keywords.js` and defines `SITEMAP_PENDING_FILE` once. |
| `src/steps/pr.js:76-103` | PR body table interpolated `p.keyword` unescaped. Newline/pipe/backtick in keyword breaks table or injects markdown. Added `mdCell()` escape. |
| `src/steps/pr.js:32` | Commit message embedded raw keywords (newline-bearing). Added `safeKeyword()` sanitizer. |
| `src/steps/pr.js:14-19` | Sitemap-slug construction iterated all locales per page even though pages are already per-locale. Removed redundant inner loop. |
| `src/commands/run.js:58-59` | `await import('path')` / `await import('fs')` inside the hot loop. Hoisted to static imports. |
| `src/commands/run.js:50` | `defaultLocale` recomputed every inner iteration. Hoisted before outer loop. |
| `src/commands/run.js:101` | `kw.status = 'pr_opened'` set unconditionally — keywords that were entirely skipped got hidden from future runs. Now only set when `producedAtLeastOne`. |
| `src/commands/init.js:74` | `landing_path` user input had no validation. Now rejects absolute paths and `..`. |
| `src/lib/keywords.js:15` | `data.updated = new Date().toISOString().slice(0, 10)` inline copy of `date.format`. Now uses `format(new Date())`. |
| `src/lib/keywords.js:9` | `JSON.parse` of `seo/keywords.json` had no try/catch. Wrapped with clearer error. |
| `src/lib/gsc.js:18, 35` | Same for credentials and token files (Round 2). |

## Minor (fixed)

| File | Issue |
|---|---|
| `src/lib/serpapi.js:24-27` | `loadQuota` called twice per `getSerp` (once in `checkQuota`, once in `incrementQuota`). Merged via `bumpQuota(currentUsed)`. |
| `package.json` | Unused `simple-git` dependency removed. |
| `src/steps/track.js:21` | CSV row built from GSC `url` + `query` (attacker-controlled) without escaping. Added `csvCell()` helper that quotes cells with `,` `"` or newline. |

## Open Points (not fixed)

These were either low-confidence findings or refactors deemed too disruptive for an audit pass. Each is suitable for a future GitHub issue.

1. **SRP — `src/commands/run.js:48-103`.** The inner `for (const kw of toGenerate)` block does locale-path resolution, FS checks, retry/validate, dry-run printing, and result collection inline. Extracting a `generateForLocale(kw, locale, ...)` helper would clarify intent. Refactor postponed; would require careful test coverage we don't have.
2. **SRP — `src/steps/discover.js:64-109`.** `scoreAndSave` mixes prompt building, API calls, collision detection, upsert. Same reasoning as above.
3. **Status enum.** Keyword statuses `'proposed' | 'done' | 'skip' | 'pr_opened' | 'validation_failed'` are stringly typed across `discover.js`, `run.js`, `keywords.js`. A central `const KEYWORD_STATUS = { ... }` would prevent typos.
4. **DRY — landing-dir enumeration.** `src/steps/discover.js:162-178` and `src/steps/generate.js:57-81` both read the landing dir, with different output shapes (headlines vs slugs). Candidates for a `lib/landings.js` module.
5. **`.env` precedence in `bin/seo.js:8-9`.** Project `.env` overrides global with `override: true`. Documented behavior, but means a compromised project repo could redirect API tokens. Consider inverting precedence or documenting the threat model.
6. **DNS rebinding gap in `src/lib/safe-fetch.js`.** `assertPublicUrl` resolves once before `fetch` resolves again. TTL-0 rebind is a theoretical bypass. Acceptable for a CLI run against trusted user-provided URLs; flagged for awareness.
7. **`src/lib/detect.js:87-93`.** Reads `.env` / `.env.example` of the target project to extract `APP_URL`. Intentional for project detection but flagged by an agent as a CLAUDE.md rule conflict. Left as-is; the rule applies to the assistant, not to the tool's runtime behavior on user-owned projects.

## What was NOT changed

- No tests written (no test runner configured in `package.json`).
- No linter run (no eslint/prettier configured).
- No frontend, no a11y / SEO / typography / UI / UX / animation findings — those agents were skipped (no eligible files).
- No commits or pushes were made.

## Convergence

- **Round 1:** 4 agents (Architecture, Security, Performance, Code Quality) → ~30 findings → 12 parallel fix-agents → all high+medium confidence findings applied.
- **Round 2:** 1 consolidated review agent → 6 minor findings, no Critical/Important. Critical+Important dropped from many → 0. SAUBER.
