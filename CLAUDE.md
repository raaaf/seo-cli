# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/seo.js init          # interactive setup, writes seo.config.yaml in cwd
node bin/seo.js run           # full pipeline: reconcile, discover, generate, one PR per keyword (also commits state to main: git pull afterwards)
node bin/seo.js run --dry-run # preview generated markdown, no state commit/PR
node bin/seo.js run --report out.json  # also write the run report (status, prs, budget, llm, warnings, errors)
node bin/seo.js improve       # rewrite the existing page with the strongest case, from live GSC data
node bin/seo.js improve --dry-run  # print the rewrite, no commit/PR
node bin/seo.js dashboard     # cross-project overview (funnel, rankings, movers, suggestions)
node bin/seo.js dashboard --live  # same, but pull current positions/clicks from GSC
node bin/seo.js check <files...>  # validate already-generated landing markdown (CI gate)
node bin/seo.js submit-sitemap    # (re)submit <base_url>/sitemap.xml to GSC
node bin/seo.js indexnow          # push all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver)
node bin/seo.js index-status      # live Google index coverage per sitemap URL, diffed against last week
node bin/seo.js conversational    # group GSC queries into AI-Mode artefacts, tracker probes and real questions
```

`dashboard` is cross-project: it auto-discovers every project with a `seo.config.yaml` under `~/Local Sites` (override via `SEO_PROJECT_ROOTS`, colon-separated) and reads their committed state files. It does *not* run in the context of a single target project. Flags: `--live`, `--project <match>`, `--json`.

No build step. Tests: `npm test` (vitest, `test/*.test.js`). Filtered: `npx vitest run test/<file>.test.js` or `npx vitest run -t <name>`. During work run only affected tests; full suite only before push. Linting: `npm run lint` (eslint flat config). ESM (`"type": "module"`), Node 18+.

## Architecture

This is a personal CLI that automates SEO landing page creation. It runs in the context of a *target project* (e.g. a Laravel or Vite site), not inside its own repo. `process.cwd()` always refers to the target project.

### Pipeline (`seo run`)

```
discover → generate → validate (up to 2 attempts) → fact-check → pr → track
```

All steps live in `src/steps/`. Orchestration is in `src/commands/run.js`: reconcile (keyword and improvement status against the real PR state via `getPR`), measure, discover, generate, `commitState` to main, one PR per keyword plus the rewrite PR, track. A `finally` block releases keywords that never got a PR, commits state again and writes the report, so a failed run keeps its status changes and budget count.

**discover** (`src/steps/discover.js`): Pulls the last 28 days of Search Console data (positions 8-25, filtered by `min_impressions`). Scores each candidate keyword via Claude + SerpAPI. Saves results to `seo/keywords.json` in the target project.

Three guards keep the backlog free of duplicates. `lib/similarity.js` rejects a candidate whose significant tokens match an existing keyword or slug (a word-order variant such as "webdesign freelancer preise" next to "freelancer webdesign preise") before it is scored. `lib/cannibalization.js` counts how many of our own landing pages already rank for that exact query and rejects the candidate from two up: the query is contested from the inside, and a new page joins that fight instead of winning it. For everything fuzzier, the scoring prompt receives the existing slugs and titles and returns `covered_by` when a published page already answers the question; that keyword is skipped with a note.

Greenfield (inventing keywords without GSC demand) is **opt-in** via `greenfield: true` and off by default. An empty backlog is a valid result: it means the topic space is covered. It used to top up whenever GSC yielded fewer keywords than `weekly_cap`, which guaranteed pages every week whether or not topics existed, and is how the target projects accumulated 70 pages for about 50 topics.

New pages are capped per project and calendar month (`max_new_pages_per_month`, default 4; Google's scaled-content-abuse policy). `newPagesThisMonth` in `lib/keywords.js` counts keywords by `pr_opened_at` (open or merged, not rejected); `reconcileState` backfills the date from the PR's creation date. At 0 left the run skips discover (no SerpAPI or scoring spend) and goes to the improve path, which does not count.

**generate** (`src/steps/generate.js`): Calls Claude Opus (`MODELS.generate`, `GENERATE_MAX_TOKENS` = 32000, since adaptive thinking on Opus 5.5 counts against `max_tokens`; effort set explicitly to `high`, interactive calls carry the server-side `default` refusal fallback) with a prompt assembled from `src/prompts/generate.md` and a style doc. Outputs markdown with YAML frontmatter. Placeholders `CANONICAL_URL`, `BASE_URL`, `SITE_NAME` are replaced post-generation. The call goes through the Message Batches API by default (`batch_generation: true`, half the interactive price), falling back to an interactive request if the batch errors or does not finish within the wait cap; `--dry-run` forces interactive since a preview should not wait on a batch.

**validate** (`src/steps/validate.js`): Pure function, no I/O. Checks frontmatter fields, meta title/description lengths, FAQ count, body word count (800-1400), keyword density, entity coverage, em-dash/emoji, umlauts written as ae/oe/ue, and fabricated-claim patterns. Returns `{ ok, errors, warnings }`. Up to 2 generation attempts per keyword.

**fact-check** (`src/steps/review.js`): Extracts checkable claims (laws, thresholds, deadlines, customs, brand and product names, third-party prices, cited studies) and verifies them with the server-side `web_search` tool, plus the tldr of every published page in the locale for cross-page number consistency. It also reads the page against itself: a price corridor, lead time or calculation that the tldr, FAQ and body state differently is a medium finding, and needs no search because the page is its own evidence. It also receives the project's style doc (the same one `generate.js` loads): a price or pricing rule that contradicts a canonical value there is a medium finding too, and the style doc outranks the sibling-page cluster when the two disagree, since the cluster can itself be wrong. Corrections apply only when the quoted text matches exactly once. A high-severity finding it could not patch drops the page; everything else is patched, revalidated and logged. A fact check that returns no JSON is retried once with an explicit JSON-only instruction; if it still fails, `reviewPage` returns `unchecked: true` instead of an empty finding list, `run` skips the page and the keyword stays `proposed` for the next run and `improve` keeps the rewrite but opens the PR with a warning that the facts were not checked. Off via `fact_check: false`, skipped in dry runs.

**pr** (`src/steps/pr.js`): One PR per keyword on `seo/new/<slug of the default-locale page>`, carrying all locale files and the counterpart of that keyword and nothing else (no state files, those go to `main` through `commitState`). `injectHreflang` runs over all pages of the run before they are grouped by keyword. The PR body has an SEO check table. The keyword entry stores `pr_url` and `sitemap_slugs`; the slugs go to `seo/sitemap-pending.json` only when the reconcile step at the next run sees the PR merged (`published`; closed without merge is `rejected` and never proposed again). A branch that already exists (`BRANCH_EXISTS`, an open PR for the same keyword) skips that keyword with a warning and sets it back to `proposed`, one failing PR never stops the others. Branches never linger as orphans: a branch whose `openPR` failed is deleted right away (`deleteBranch`), and the reconcile step deletes the head branch of a PR that was closed without merge, so `BRANCH_EXISTS` only ever means a live PR. The gate that auto-merges such a PR also resubmits the sitemap to Google and, when `indexnow_key` is set, pushes all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver) via `seo indexnow`.

**improve** (`src/steps/improve.js`, `src/commands/improve.js`): Runs when the backlog is empty, and standalone via `seo improve`. Aggregates live GSC page/query data per landing page of the default locale and picks the one with the strongest case. Scoring uses a page's *reachable* impressions, meaning those from queries at position 20 or better, not its total: the total counts long-tail queries at position 70 that no rewrite moves, and scoring on it sent the budget to pages that could not be helped (`onlineshop-erstellen-lassen`, 4690 impressions with 5 in reach, outranked `freelancer-webdesign-fuerth`, 786 with 759 in reach). A page with at least 30 percent of its impressions on page one whose CTR sits below half of what its position normally returns is a snippet problem (title and description); a page within reach of page one is a relevance problem; anything further out scores lowest. The CTR curve comes from published English-language studies, is not calibrated for German SERPs, and is used only to compare a page against itself. The rewrite gets the page's actual queries as context and may not claim services the page does not already claim. It also gets the project's style doc, with instructions that a price or pricing rule stated there overrides whatever figure the current page states. Rewritten slugs go into `seo/improvements.json` and are off the list for 56 days. The rewrite goes through the Message Batches API like `generate` (`batch_generation`), and `--dry-run` forces interactive; the fact check stays interactive because `complete()` rejects batch together with web search. The current page is validated first and its warnings and errors go into the prompt as `current_issues` (a headline without the keyword may be rewritten), so the rewrite fixes what the validator already flags; warnings that remain on the rewrite are listed in the PR body. When the rewritten page names an existing counterpart via `alternate:`, the counterpart is re-adapted from the checked rewrite (same slug, steps/checklist/faq counts must match) and ships in the same PR; if that fails twice the German rewrite is kept and the PR body says to sync by hand. The rewrite is split in `prepareImprove` (selection, rewrite, validation, fact check, no commit, no cooldown entry) and `publishImprove` (PR on `seo/improve/<slug>`, cooldown entry with `pr_url` only after the PR exists; `BRANCH_EXISTS` skips with a warning and sets no cooldown). `seo improve` runs prepare, `commitState`, publish, `commitState`; `seo run` calls the two halves itself. A merged rewrite PR keeps its cooldown entry (`merged_at` is set by the reconcile step), a closed one loses it.

Two cluster guards, added after an improve run pushed a page further into its neighbour's topic: `selectPage` drops every query another landing page ranks better for, before scoring, so a page is neither picked for nor rewritten towards impressions that belong elsewhere (the dropped ones are logged and kept on `page.foreignQueries`). For the fuzzier half, the prompt receives the slugs of all sibling pages and the instruction to trim, not extend, whatever reaches into their topics.

**index-check** (`src/steps/index-check.js`, `src/commands/index-status.js`): Inspects the live Google index state of every sitemap URL (capped at 500, well inside the URL Inspection API quota of 2000/day and 600/min per property) and diffs it against `seo/index-status.json` from the previous run, reporting newly dropped, newly indexed and still-missing URLs. It exists because `zeit.rafaelalex.de` lost its whole index on 2026-08-04 and nobody noticed for five weeks: a quiet week and a silently deindexed one both print "nothing to do". A first run writes a baseline rather than claiming everything just dropped. `--commit` (used only by the weekly workflow) pushes the snapshot straight to `main` through `commitState`, with `[skip ci]` in the message because portfolio-2025 deploys to FTP on every unfiltered push.

**conversational** (`src/lib/conversational.js`, `src/commands/conversational.js`): A reading instrument, not a pipeline step. Google folds AI Mode and AI Overview activity into the ordinary web search type and counts every follow-up turn as its own query, so conversation fragments, full natural-language prompts and AI-visibility-tracker probes land in the query table. The classifier is deterministic pattern matching into `artefact`, `tracker_probe`, `conversational` and `keyword`. Deliberately not wired into `discover`: making it an input is a separate decision.

**measure** (`src/steps/measure.js`, pure rules in `src/lib/measure.js`, ledger in `src/lib/changes.js`): runs right after the reconcile. `reconcileState` adds a `seo/changes.json` entry per merged PR (only with a real `mergedAt`; a separate backfill pass covers PRs merged in the last 90 days (by merge date) without an entry and retries unreadable ones; PRs that were read but never qualify, no real merge date or older, go to `skipped` in `changes.json` and are not read again; a rewrite stored without its counterpart gets the counterpart URL once the `alternate:` is on disk). Each due reading (`d28` = merge+8..+35, `d56` = merge+36..+63, baseline merge-28..-1, due 3 days after the window ends) costs up to three `queryPageTotals` calls, no LLM. New pages get absolute values; rewrites a verdict against control pages (same language, no ledger entry merged in merge-28..merge+63), strict rules: 90th/10th percentile of `r` plus 1.3x/0.7x the median, at least 12 controls, `insufficient_data` reasons `volume` (baseline only, so a collapsed page stays measurable)/`control`/`dispersion`/`overlap`/`missing` (target had a baseline but no GSC row in the reading window, never read as zero). A target URL that maps to no landing page gets `unmapped: true` once and is never measured (counted under `unmapped`). `d56` is only computed once `d28` exists. Two negative readings with effect <= 0.7 set `revert_candidate` and warn (acting on it is Etappe C). A window without any landing page impressions is an error: warning, nothing saved. Errors never stop the run, `--dry-run` writes nothing. Result in `report.measurement` (counts and this run's changes only).

**track** (`src/steps/track.js`): Appends GSC page/query performance to `seo/rankings/YYYY-WW.csv`. Gitignored in target projects.

### Key lib files

| File | Role |
|---|---|
| `src/lib/claude.js` | Anthropic SDK wrapper. Singleton client, up to 4 total attempts on 502/503/529. System prompt uses `cache_control: ephemeral`. `complete({ batch: true })` submits a single-request Message Batch, polls, and falls back to an interactive call on error, non-success, or wait-cap timeout. The interactive call streams (`messages.stream(...).finalMessage()`); a response (batch or interactive) that ends at `stop_reason: max_tokens` throws instead of reaching `validate.js` truncated. With `CLAUDE_CODE_OAUTH_TOKEN` set, `complete()` goes through `claude-code.js` first (`SEO_LLM_BACKEND=api` or `backend: 'api'` force the API, batch is ignored there). An error repeats that call on the API; a limit without family, an auth error or a timeout switches all later calls to the API for good, an Opus/Sonnet limit only that family; after 60 minutes the process stays on the API with `batch: false`. `getLlmStats()` / `resetLlmState()` expose and clear the counters and fallbacks (`report.llm`). |
| `src/lib/claude-code.js` | `completeViaClaudeCode` and `ClaudeCodeError` (`kind`: `limit`, `auth`, `timeout`, `error`; `family` on a model-family limit). Runs `claude -p` in an empty temp dir with an env allowlist (no `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `SERPAPI_KEY`), 8 minute timeout, prompt on stdin, schema via `--json-schema`. Claude Code is pinned to 2.1.292 in `seo-reusable.yml`, installed only when the token secret exists. Token: `claude setup-token`, valid one year, rotate by replacing the secret in every project repo. |
| `src/lib/gsc.js` | Google Search Console via `googleapis`. Supports both service account and OAuth2 desktop app. Token cached at `~/.seo-cli-token.json`. Queries ask for the API ceiling of 25000 rows and warn when a response comes back at exactly that size: the old 500-row cap truncated silently and every aggregate built on it was a biased sample. |
| `src/lib/serpapi.js` | SerpAPI wrapper. Searches are counted in `seo/budget.json` (per project and month, limit `budget.serpapi_per_month`, default 60); once per process the free `account.json` is read and its `total_searches_left` caps the remainder. |
| `src/lib/budget.js` | `seo/budget.json`: SerpAPI count and Anthropic API spend per month plus `subscription: { calls, usd_equivalent }` (`addSubscriptionUsage`, never checked against a limit), limits from `budget:` in the config, `assertBudget` throws `BudgetExceededError` (run ends `budget_exceeded`, exit 0). |
| `src/lib/changes.js` / `src/lib/measure.js` | Change ledger load/save/`upsertEntry` (a corrupt file throws, never reads as empty) and the pure measurement rules (windows, URL-to-slug, control selection, verdict, overlap, revert candidate). |
| `src/lib/state.js` | `STATE_FILES` and `commitState({ cwd, repo, reason })`: commits the state files that differ from `main` (Git blob SHA comparison) to `main` with `[skip ci]`, no commit when nothing differs. |
| `src/lib/keywords.js` | Load/save/upsert `seo/keywords.json`. Defines `KEYWORD_STATUS` enum, `SLUG_REGEX`/`isValidSlug`, and state-file path constants. |
| `src/lib/config.js` | Loads `seo.config.yaml` from cwd via `js-yaml`, merges `DEFAULTS`. Also `defaultLocale`/`localeLandingPath` helpers. |
| `src/lib/template.js` | `fillTemplate`: single-pass `{{placeholder}}` substitution. Substituted content is never re-scanned (guards against double-substitution injection). `sanitizeUntrusted` strips `<<<`/`>>>` fence markers from substituted values. |
| `src/lib/seo-thresholds.js` | `SEO_THRESHOLDS`: shared meta/tldr/body limits consumed by `validate.js` and `pr.js` (prevents threshold drift). |
| `src/lib/models.js` | `MODELS`: single source of truth for Claude model ids (`generate` = Opus 5.5, `default` = Sonnet 5.5). Consumed by `generate.js` and `claude.js`. |
| `src/lib/frontmatter.js` | `splitFrontmatter`/`parseFrontmatter`: parse YAML frontmatter from markdown. Canonical parser, shared by all consumers. |
| `src/lib/safe-fetch.js` | `safeFetch`: SSRF guard. Resolves DNS and blocks private/reserved IPs before fetching. |
| `src/lib/site-fetch.js` | `fetchPages`/`stripHtml`: fetch a list of URLs (via `safeFetch`) and strip to plain text. |
| `src/lib/landings.js` | `getExistingSlugs`/`getExistingTitles`/`getExistingPages`: enumerate on-disk landing pages. Module-scope memo cache. |
| `src/lib/index-status.js` | Fetch/load/save/diff Google index coverage per URL. The "is indexed" predicate lists Google's three not-indexed wordings in one place, because that wording drifts. |
| `src/lib/conversational.js` | `classifyQuery`/`groupConversational`: deterministic buckets for AI-Mode traces in GSC query rows. No LLM. |
| `src/lib/improvements.js` | Load/save `seo/improvements.json`, plus the 56-day cooldown per slug. |
| `src/lib/similarity.js` | `findTokenSetDuplicate`: rejects word-order variants of keywords/slugs we already cover. |
| `src/lib/cannibalization.js` | `competingPages`/`isCannibalized`: counts our own landing pages already ranking for a query, from GSC page/query rows. |
| `src/lib/detect.js` | `detectProject`: heuristics for `seo init` (git remote, landing path, style doc, locale, clusters, domain). |
| `src/lib/github.js` | Octokit wrapper: `createBranchAndCommit` (never forces, `BRANCH_EXISTS` on an existing branch), `commitToBranch` (no force, retries after 422), `getBlobShas`, `openPR`, `getPR` (open/merged/closed plus `headRef`), `deleteBranch` (404 tolerated). |
| `src/lib/projects.js` | `discoverProjects`: walk `SEO_PROJECT_ROOTS` for projects with a `seo.config.yaml` (used by `dashboard`). |
| `src/lib/dashboard.js` | Aggregates funnel counts, ranking snapshots, movers, and suggestions per project. |
| `src/lib/analyze-site.js` / `src/lib/generate-style-doc.js` | `seo init` helpers: Claude-derived site analysis and writing-style guide from fetched copy. |
| `src/lib/date.js` | Date helpers (`format`, `subDays`, `isoWeek`). |

### Prompts

`src/prompts/` contains markdown templates with `{{placeholder}}` substitution via `lib/template.js#fillTemplate` (single-pass, no templating engine). Untrusted external data (SerpAPI titles/snippets, GSC queries, fetched site copy) is wrapped in `<<<UNTRUSTED_*_START>>>` / `<<<UNTRUSTED_*_END>>>` markers inside the templates so the model treats it as data, not instructions:

- `score.md` — keyword scoring, returns JSON
- `greenfield.md` — keyword discovery without GSC data (only used when `greenfield: true`)
- `review.md` — fact check with web search, returns findings as JSON
- `improve.md` — rewrite of an existing page against its real GSC queries
- `generate.md` — full page generation (used with Opus)
- `counterpart.md` — counterpart-locale page adaptation (used with Opus, see Counterpart-locale support below)
- `style-default.md` — built-in writing style guide, used when `config.style_doc` is null

### State files (in target project, not this repo)

| Path | Purpose | Git |
|---|---|---|
| `seo/keywords.json` | Keyword backlog with statuses (`proposed`, `pr_opened` with `pr_url`, `published`, `rejected`, ...) | state commit to main |
| `seo/sitemap-pending.json` | Slugs queued for sitemap, added when the keyword's PR is merged | state commit to main |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |
| `seo/improvements.json` | Which pages were rewritten when, with the queries that drove it, `pr_url`, `merged_at` | state commit to main |
| `seo/changes.json` | Change ledger: one entry per merged seo PR (`kind` new/rewrite, `urls`, `merged_at`, `baseline`, readings `d28`/`d56`, `revert_candidate`) | state commit to main |
| `seo/index-status.json` | Last week's Google index coverage per sitemap URL, for the weekly diff | state commit to main |
| `seo/budget.json` | SerpAPI searches, Anthropic API spend and subscription usage of the month | state commit to main |

### Multi-locale support

When `config.locales` has more than one entry, `generateForLocale` runs for each locale. The `landing_path` is rewritten by substituting the locale segment (e.g. `/de/` to `/en/`). `pr.js` injects `hreflang` blocks into frontmatter for multi-locale pages.

### Counterpart-locale support

A separate, orthogonal model from multi-locale: when `config.counterpart_locale` is set (e.g. `en`) and differs from the default locale, every successfully generated+validated default-locale page also gets a counterpart page (`src/steps/counterpart.js`, prompt `src/prompts/counterpart.md`). Unlike multi-locale hreflang pages, the counterpart gets its **own** slug (chosen by the model, checked for collisions across both locale directories) and both pages share the bare `/{slug}` URL space (no locale prefix), reciprocally linked via an `alternate:` frontmatter field (`linkAlternates` in `counterpart.js`). `validate()` accepts a `{ counterpart: true }` option that skips the German-specific denylist and source-keyword/entity checks for the adapted page while keeping structural and brand-casing checks. A counterpart failure after 2 attempts is logged and skipped. In `run` the pair ships together or not at all: the keyword stays `proposed` and becomes `validation_failed` (with a `note`, counter `counterpart_failures`) after the second dropped run; in `improve` the rewrite is kept and the PR says to sync by hand. `improve` reuses this flow through `generateValidatedCounterpart` (`src/steps/counterpart-loop.js`) with `fixedSlug`, so the existing counterpart keeps its slug. Both `run` and `improve` pass `matchCounts: true`, so a counterpart whose steps/checklist/faq counts differ from its source is a validation error and gets one retry (the site's landing-sync test requires equal counts).

### .env loading order

`bin/seo.js` loads the CLI's own `.env` first (global API keys), then the target project's `.env` with `override: true` so project-level values win.
