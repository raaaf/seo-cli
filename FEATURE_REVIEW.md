# Feature Review

Holistic read of `FEATURE_AUDIT.md` as one product. Each finding references the affected row `ID`(s).
This file is an artifact only: no code or tests were changed to produce it.

## Inconsistencies

- **Two divergent locale-path schemes.** Filesystem paths are derived by swapping the `/{default}/`
  segment (`config-locale` `localeLandingPath`, consumed by `landings`, `generate-page`), while PR
  URLs/sitemap slugs are derived by prefixing `{locale}/` only for non-default locales
  (`pr-create` `localeSlug`). The two never reconcile, so a `landing_path` that does not contain a
  `/{default}/` segment silently writes every locale to the same directory while still emitting
  distinct hreflang URLs. Affected: `config-locale`, `landings`, `generate-page`, `pr-create`.
- **Keyword presence is checked on the first token only.** `validate-page` tests headline/body
  keyword presence via `keyword.split(' ')[0]`, and `check-cmd` reconstructs the keyword from the
  slug (`slug.replace('-', ' ')`). A multi-word keyword therefore passes on a single shared word,
  so the check-side keyword and the discover-side keyword can diverge without failing validation.
  Affected: `validate-page`, `check-cmd`, `keywords-store`.
- **Model tier is implicit per call site.** `generate-page` pins `claude-opus-4-7` at the call site
  while `claude-complete` defaults to `claude-sonnet-4-6`; scoring/greenfield (`discover-run`) rely
  on that default. The split is intentional but undocumented at the row level, so a model bump must
  be applied in two unrelated places. Affected: `generate-page`, `claude-complete`, `discover-run`.

## Gaps

- **No automated story for the full `seo run` pipeline.** Only the env guard (`run-env`) is covered;
  the discover→generate→validate→pr→track orchestration, the 2-attempt retry, and the
  slug-collision/`pLimit` concurrency paths live in *Needs human review*. The partial-failure
  rollback (PR opens fail → keyword status reset to `proposed`) has no test. Affected: `run-env`,
  `generate-page`, `pr-create`, `github-commit`.
- **Weekly CSV growth has a hard stop but no rotation.** `track-run` skips writing once the file
  exceeds 5 MB and asks the user to rename it manually; there is no automated rotation or alert, so
  tracking silently stops accumulating. Affected: `track-run`.
- **SerpAPI exhaustion degrades silently.** `discover-run` swallows `getSerp` failures into empty
  SERP data and still proposes keywords; a fully exhausted monthly quota (`serpapi-quota`) yields
  pages generated with no PAA/related-search context and no surfaced warning to the operator.
  Affected: `discover-run`, `serpapi-getserp`, `serpapi-quota`.
- **Live-pull failure has only a data-layer path.** `dashboard-summary` records `liveError`, but the
  rendering of that error (and the empty/loading state of `dashboard --live`) is cosmetic and sits
  in *Needs human review*; there is no story asserting the user actually sees the failure reason.
  Affected: `dashboard-summary`, `dashboard-cmd`.

## Potentials

- **Unify locale-path derivation.** Extract one helper that produces both the filesystem path and
  the public URL slug for a (config, locale) pair, and have `localeLandingPath`/`localeSlug` call it.
  Rationale: removes the single largest source of multi-locale drift (`config-locale`, `pr-create`).
- **Add a mocked `seo run` smoke test.** With discover/generate/pr/track already mockable (proven by
  `discover-run`, `generate-page`, `pr-create`, `track-run`), one integration test could assert the
  end-to-end happy path and the PR-failure rollback. Rationale: covers the product's core flow that
  is currently only human-reviewed.
- **Quiet the git probe in `detect-project`.** `detectProject` shells out to `git remote get-url`
  and leaks `fatal: not a git repository` to stderr in non-git dirs (visible in the test run); a
  `stdio: ['ignore','pipe','ignore']` on the `execSync` would silence it. Rationale: cleaner output,
  no behavior change (`detect-project`).
- **Share the "valid page" fixture.** `validate-page` and `check-cmd` each build a ~900-word valid
  document inline; extracting one builder into a test helper keeps the canonical "passing page" in a
  single place. Rationale: DRY + prevents the two from drifting (`validate-page`, `check-cmd`).
- **Surface OAuth token expiry at runtime.** GSC OAuth tokens expire roughly weekly (Testing-mode
  app); a clear "re-mint token / use a service account" hint on `invalid_grant` would cut recurring
  failures. Rationale: recurring operational pain in the GSC path (Needs human review: `gsc.js`).
