# Feature Review

Holistic read of `FEATURE_AUDIT.md` as one product. Each finding references the affected row `ID`(s).
The findings from the first pass have been worked through; status is recorded inline.

## Inconsistencies

- **[Resolved] Two divergent locale-path schemes.** A single `localeUrlPath(config, slug, locale)`
  helper now owns the default-locale rule and is used by `pr.js` for both sitemap slugs and hreflang;
  `localeLandingPath` was hardened so a non-default locale appends its segment instead of colliding
  into the default directory when the path has no `/{default}/` segment. Affected: `config-locale`,
  `pr-create`, `landings`, `generate-page`.
- **[Resolved] Keyword presence checked on the first token only.** `validate` now checks every
  significant keyword token (4+ chars) in headline and body and names the missing ones; still a
  warning, not a gate, so it does not break existing pages. Affected: `validate-page`. Note: the
  check-side keyword reconstruction from the slug (`check-cmd`) is unchanged and remains a best-effort
  fallback when `keywords.json` lacks the entry.
- **[Resolved] Model tier implicit per call site.** `src/lib/models.js` is now the single source of
  truth (`MODELS.generate` / `MODELS.default`), consumed by `generate.js` and `claude.js`; tests pin
  both ids. Affected: `generate-page`, `claude-complete`, `discover-run`.

## Gaps

- **[Resolved] No automated story for the full `seo run` pipeline.** New `run-pipeline` covers the
  happy path (discover→generate→pr→track + PR url recorded), the PR-failure rollback (keyword status
  reset to `proposed`), and `--dry-run`. The `pLimit` concurrency cap and the multi-keyword 2-attempt
  retry remain in *Needs human review*. Affected: `run-pipeline`, `run-env`.
- **[Resolved] Weekly CSV growth had a hard stop but no rotation.** `track` now auto-rotates an
  oversized CSV to `<week>-partN.csv` (still read by the dashboard's CSV scan) and writes a fresh
  weekly file instead of silently skipping. Affected: `track-run`.
- **[Resolved] SerpAPI exhaustion degraded silently.** `discover` now prints an explicit warning when
  the monthly quota is exhausted, so the operator knows pages are produced without SERP context.
  Affected: `discover-run`, `serpapi-quota`.
- **[Resolved] Live-pull failure had only a data-layer path.** `dashboard-cmd` now has a test
  asserting the `liveError` reason is rendered in the human overview (the renderer already emitted
  it). Affected: `dashboard-summary`, `dashboard-cmd`.

## Potentials

- **[Resolved] Unify locale-path derivation.** Done as part of the locale-path consolidation above
  (`localeUrlPath`). Affected: `config-locale`, `pr-create`.
- **[Resolved] Add a mocked `seo run` smoke test.** Done (`run-pipeline`).
- **[Resolved] Quiet the git probe in `detect-project`.** `execSync` now runs with
  `stdio: ['ignore','pipe','ignore']`; the `fatal: not a git repository` noise is gone from the test
  run. Affected: `detect-project`.
- **[Resolved] Share the "valid page" fixture.** Extracted to `test/helpers/valid-page.js` and used by
  both `validate-page` and `check-cmd`. Affected: `validate-page`, `check-cmd`.
- **[Resolved] Surface OAuth token expiry at runtime.** `describeAuthError` maps `invalid_grant` /
  expired-token failures to a re-auth / service-account hint; GSC queries and sitemap submit rethrow
  with it. Affected: `gsc-auth-error`. The interactive OAuth browser flow itself stays human-review.

## Remaining (Needs human review)

- `seo run` `pLimit` concurrency cap and multi-keyword retry edge cases.
- GSC OAuth desktop browser flow, token caching, and the live googleapis query calls (the
  `invalid_grant` hint is covered).
- `seo init` interactive inquirer flow.
- Subjective LLM output quality: `analyze-site.js`, `generate-style-doc.js`.
- Dashboard ANSI rendering cosmetics (the data layer and the `liveError` line are covered).
- Nested duplicate project configs under one root (e.g. `events app/` and `events app/snaggletooth/`
  both resolve to project `events`); decide whether `discoverProjects` should dedupe by project name.
