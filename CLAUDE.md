# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/seo.js init          # interactive setup, writes seo.config.yaml in cwd
node bin/seo.js run           # full pipeline: discover + generate + PR
node bin/seo.js run --dry-run # preview generated markdown, no commit/PR
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

No build step. Tests: `npm test` (vitest, `test/*.test.js`). Linting: `npm run lint` (eslint flat config). ESM (`"type": "module"`), Node 18+.

## Architecture

This is a personal CLI that automates SEO landing page creation. It runs in the context of a *target project* (e.g. a Laravel or Vite site), not inside its own repo. `process.cwd()` always refers to the target project.

### Pipeline (`seo run`)

```
discover → generate → validate (up to 2 attempts) → fact-check → pr → track
```

All steps live in `src/steps/`. Orchestration is in `src/commands/run.js`.

**discover** (`src/steps/discover.js`): Pulls the last 28 days of Search Console data (positions 8-25, filtered by `min_impressions`). Scores each candidate keyword via Claude + SerpAPI. Saves results to `seo/keywords.json` in the target project.

Three guards keep the backlog free of duplicates. `lib/similarity.js` rejects a candidate whose significant tokens match an existing keyword or slug (a word-order variant such as "webdesign freelancer preise" next to "freelancer webdesign preise") before it is scored. `lib/cannibalization.js` counts how many of our own landing pages already rank for that exact query and rejects the candidate from two up: the query is contested from the inside, and a new page joins that fight instead of winning it. For everything fuzzier, the scoring prompt receives the existing slugs and titles and returns `covered_by` when a published page already answers the question; that keyword is skipped with a note.

Greenfield (inventing keywords without GSC demand) is **opt-in** via `greenfield: true` and off by default. An empty backlog is a valid result: it means the topic space is covered. It used to top up whenever GSC yielded fewer keywords than `weekly_cap`, which guaranteed pages every week whether or not topics existed, and is how the target projects accumulated 70 pages for about 50 topics.

**generate** (`src/steps/generate.js`): Calls Claude Opus (`MODELS.generate`, `GENERATE_MAX_TOKENS` = 32000, since adaptive thinking on Opus 5.5 counts against `max_tokens`; effort set explicitly to `high`, interactive calls carry a refusal fallback to Opus 5) with a prompt assembled from `src/prompts/generate.md` and a style doc. Outputs markdown with YAML frontmatter. Placeholders `CANONICAL_URL`, `BASE_URL`, `SITE_NAME` are replaced post-generation. The call goes through the Message Batches API by default (`batch_generation: true`, half the interactive price), falling back to an interactive request if the batch errors or does not finish within the wait cap; `--dry-run` forces interactive since a preview should not wait on a batch.

**validate** (`src/steps/validate.js`): Pure function, no I/O. Checks frontmatter fields, meta title/description lengths, FAQ count, body word count (800-1400), keyword density, entity coverage, em-dash/emoji, umlauts written as ae/oe/ue, and fabricated-claim patterns. Returns `{ ok, errors, warnings }`. Up to 2 generation attempts per keyword.

**fact-check** (`src/steps/review.js`): Extracts checkable claims (laws, thresholds, deadlines, customs, brand and product names, third-party prices, cited studies) and verifies them with the server-side `web_search` tool, plus the tldr of every published page in the locale for cross-page number consistency. It also reads the page against itself: a price corridor, lead time or calculation that the tldr, FAQ and body state differently is a medium finding, and needs no search because the page is its own evidence. It also receives the project's style doc (the same one `generate.js` loads): a price or pricing rule that contradicts a canonical value there is a medium finding too, and the style doc outranks the sibling-page cluster when the two disagree, since the cluster can itself be wrong. Corrections apply only when the quoted text matches exactly once. A high-severity finding it could not patch drops the page; everything else is patched, revalidated and logged. Off via `fact_check: false`, skipped in dry runs.

**pr** (`src/steps/pr.js`): Commits all generated files plus `seo/keywords.json` and `seo/sitemap-pending.json` to a branch named `seo/YYYY-WW`, then opens a GitHub PR with an SEO check table in the body. Writes `seo/last-pr.json` for CI auto-merge workflows. The gate that auto-merges such a PR also resubmits the sitemap to Google and, when `indexnow_key` is set, pushes all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver) via `seo indexnow`.

**improve** (`src/steps/improve.js`, `src/commands/improve.js`): Runs when the backlog is empty, and standalone via `seo improve`. Aggregates live GSC page/query data per landing page of the default locale and picks the one with the strongest case. Scoring uses a page's *reachable* impressions, meaning those from queries at position 20 or better, not its total: the total counts long-tail queries at position 70 that no rewrite moves, and scoring on it sent the budget to pages that could not be helped (`onlineshop-erstellen-lassen`, 4690 impressions with 5 in reach, outranked `freelancer-webdesign-fuerth`, 786 with 759 in reach). A page with at least 30 percent of its impressions on page one whose CTR sits below half of what its position normally returns is a snippet problem (title and description); a page within reach of page one is a relevance problem; anything further out scores lowest. The CTR curve comes from published English-language studies, is not calibrated for German SERPs, and is used only to compare a page against itself. The rewrite gets the page's actual queries as context and may not claim services the page does not already claim. It also gets the project's style doc, with instructions that a price or pricing rule stated there overrides whatever figure the current page states. Rewritten slugs go into `seo/improvements.json` and are off the list for 56 days. Own branch `seo/improve-YYYY-WW`.

Two cluster guards, added after an improve run pushed a page further into its neighbour's topic: `selectPage` drops every query another landing page ranks better for, before scoring, so a page is neither picked for nor rewritten towards impressions that belong elsewhere (the dropped ones are logged and kept on `page.foreignQueries`). For the fuzzier half, the prompt receives the slugs of all sibling pages and the instruction to trim, not extend, whatever reaches into their topics.

**index-check** (`src/steps/index-check.js`, `src/commands/index-status.js`): Inspects the live Google index state of every sitemap URL (capped at 50) and diffs it against `seo/index-status.json` from the previous run, reporting newly dropped, newly indexed and still-missing URLs. It exists because `zeit.rafaelalex.de` lost its whole index on 2026-08-04 and nobody noticed for five weeks: a quiet week and a silently deindexed one both print "nothing to do". A first run writes a baseline rather than claiming everything just dropped. `--commit` (used only by the weekly workflow) pushes the snapshot straight to `main`, with `[skip ci]` in the message because portfolio-2025 deploys to FTP on every unfiltered push.

**conversational** (`src/lib/conversational.js`, `src/commands/conversational.js`): A reading instrument, not a pipeline step. Google folds AI Mode and AI Overview activity into the ordinary web search type and counts every follow-up turn as its own query, so conversation fragments, full natural-language prompts and AI-visibility-tracker probes land in the query table. The classifier is deterministic pattern matching into `artefact`, `tracker_probe`, `conversational` and `keyword`. Deliberately not wired into `discover`: making it an input is a separate decision.

**track** (`src/steps/track.js`): Appends GSC page/query performance to `seo/rankings/YYYY-WW.csv`. Gitignored in target projects.

### Key lib files

| File | Role |
|---|---|
| `src/lib/claude.js` | Anthropic SDK wrapper. Singleton client, up to 4 total attempts on 502/503/529. System prompt uses `cache_control: ephemeral`. `complete({ batch: true })` submits a single-request Message Batch, polls, and falls back to an interactive call on error, non-success, or wait-cap timeout. The interactive call streams (`messages.stream(...).finalMessage()`); a response (batch or interactive) that ends at `stop_reason: max_tokens` throws instead of reaching `validate.js` truncated. |
| `src/lib/gsc.js` | Google Search Console via `googleapis`. Supports both service account and OAuth2 desktop app. Token cached at `~/.seo-cli-token.json`. Queries ask for the API ceiling of 25000 rows and warn when a response comes back at exactly that size: the old 500-row cap truncated silently and every aggregate built on it was a biased sample. |
| `src/lib/serpapi.js` | SerpAPI wrapper. Quota tracked in `~/.seo-cli-serpapi.json`, resets monthly. Hard stop at 240/month (free tier is 250/month). |
| `src/lib/keywords.js` | Load/save/upsert `seo/keywords.json`. Defines `KEYWORD_STATUS` enum, `SLUG_REGEX`/`isValidSlug`, and state-file path constants. |
| `src/lib/config.js` | Loads `seo.config.yaml` from cwd via `js-yaml`, merges `DEFAULTS`. Also `defaultLocale`/`localeLandingPath` helpers. |
| `src/lib/template.js` | `fillTemplate`: single-pass `{{placeholder}}` substitution. Substituted content is never re-scanned (guards against double-substitution injection). `sanitizeUntrusted` strips `<<<`/`>>>` fence markers from substituted values. |
| `src/lib/seo-thresholds.js` | `SEO_THRESHOLDS`: shared meta/tldr/body limits consumed by `validate.js` and `pr.js` (prevents threshold drift). |
| `src/lib/models.js` | `MODELS`: single source of truth for Claude model ids (`generate` = Opus, `default` = Sonnet). Consumed by `generate.js` and `claude.js`. |
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
| `src/lib/github.js` | Octokit wrapper: branch/commit creation and PR opening. |
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
| `seo/keywords.json` | Keyword backlog with statuses | commit |
| `seo/sitemap-pending.json` | Slugs queued for sitemap | commit |
| `seo/last-pr.json` | Last PR URL for CI | commit |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |
| `seo/improvements.json` | Which pages were rewritten when, with the queries that drove it | commit |
| `seo/index-status.json` | Last week's Google index coverage per sitemap URL, for the weekly diff | commit |

### Multi-locale support

When `config.locales` has more than one entry, `generateForLocale` runs for each locale. The `landing_path` is rewritten by substituting the locale segment (e.g. `/de/` to `/en/`). `pr.js` injects `hreflang` blocks into frontmatter for multi-locale pages.

### Counterpart-locale support

A separate, orthogonal model from multi-locale: when `config.counterpart_locale` is set (e.g. `en`) and differs from the default locale, every successfully generated+validated default-locale page also gets a counterpart page (`src/steps/counterpart.js`, prompt `src/prompts/counterpart.md`). Unlike multi-locale hreflang pages, the counterpart gets its **own** slug (chosen by the model, checked for collisions across both locale directories) and both pages share the bare `/{slug}` URL space (no locale prefix), reciprocally linked via an `alternate:` frontmatter field (`linkAlternates` in `counterpart.js`). `validate()` accepts a `{ counterpart: true }` option that skips the German-specific denylist and source-keyword/entity checks for the adapted page while keeping structural and brand-casing checks. A counterpart failure after 2 attempts is logged and skipped; the default-locale page is still produced.

### .env loading order

`bin/seo.js` loads the CLI's own `.env` first (global API keys), then the target project's `.env` with `override: true` so project-level values win.
