# Feature Audit

Canonical feature table for `seo-cli`. Every row maps to a user-facing feature, command, or
exported entry point, has a story and expected behaviour derived from the code, and is covered by
at least one automated test that references the row `ID` in its `describe`/`test` name.

test-command: npm test

**Stack:** Node 18+ ESM CLI (`"type": "module"`), Vitest test runner, ESLint flat config. No build step.

**Source layout:**
- `bin/seo.js` — Commander CLI entry, registers subcommands.
- `src/commands/` — one file per CLI subcommand (`init`, `run`, `check`, `dashboard`, `submit-sitemap`).
- `src/steps/` — pipeline stages (`discover`, `generate`, `validate`, `pr`, `track`).
- `src/lib/` — shared libs (config, keywords, claude, gsc, serpapi, github, frontmatter, template, etc.).
- `src/prompts/` — markdown prompt templates with `{{placeholder}}` substitution.
- `test/` — Vitest specs (`*.test.js`).

## Features

| ID | Feature | User story | Expected behaviour | Status | Test | Notes |
|---|---|---|---|---|---|---|
| cli-entry | CLI command registry | As a user I run `seo <cmd>` and see the available subcommands | `bin/seo.js` registers `init`, `run`, `check`, `dashboard`, `submit-sitemap` via commander; `--help` lists them and exits 0 | passing | test/cli.test.js › cli-entry | spawns the binary |
| config-load | Load config | As the pipeline I load `seo.config.yaml` merged with defaults | `loadConfig` merges `DEFAULTS`, explicit values win, throws when file missing | passing | test/config.test.js › config-load: loadConfig | existing |
| config-locale | Locale helpers | As multi-locale support I resolve the default locale and rewrite landing paths per locale | `defaultLocale` prefers `locales[0]` then `locale` then `de`; `localeLandingPath` swaps or appends the locale segment; `localeUrlPath` is the shared default-locale URL rule | passing | test/config.test.js › config-locale | existing |
| config-save | Save config | As `seo init` I persist the chosen config to YAML | `saveConfig` writes YAML that `loadConfig` reads back to the same object | passing | test/config-save.test.js › config-save | new |
| template-fill | Fill template | As prompt assembly I substitute `{{placeholder}}` once | `fillTemplate` single-pass, leaves unknown keys, coerces null/number, strips fences | passing | test/template.test.js › template-fill: fillTemplate | existing |
| template-sanitize | Sanitize untrusted | As prompt safety I strip fence markers from external data | `sanitizeUntrusted` removes runs of 3+ `<`/`>`, leaves normal/HTML text | passing | test/template.test.js › template-sanitize: sanitizeUntrusted | existing |
| thresholds | SEO thresholds | As validators I share one frozen set of meta/body limits | `SEO_THRESHOLDS` is frozen and its values match the documented limits | passing | test/seo-thresholds.test.js › thresholds: SEO_THRESHOLDS | existing |
| safe-fetch-assert | SSRF guard | As a fetcher I refuse private/reserved targets | `assertPublicUrl` rejects bad protocols, localhost, and private/reserved IP ranges | passing | test/safe-fetch.test.js › safe-fetch-assert: assertPublicUrl | existing |
| safe-fetch-redirect | Redirect guard | As a fetcher I re-validate every redirect hop | `safeFetch` blocks redirects to private IPs, caps redirects, returns 200 unchanged | passing | test/safe-fetch.test.js › safe-fetch-redirect: safeFetch redirect handling | existing |
| serpapi-quota | SerpAPI quota | As a budget guard I track monthly SerpAPI usage | quota starts fresh per month, resets on month change, migrates weekly files, refunds on failure, hard-stops at limit | passing | test/serpapi.test.js › serpapi-quota | existing |
| serpapi-getserp | SerpAPI fetch | As discovery I get top titles/snippets/PAA/related for a keyword | `getSerp` throws without key or quota, parses `organic_results`/`related_questions`/`related_searches`, refunds on non-2xx | passing | test/serpapi-getserp.test.js › serpapi-getserp | new |
| validate-page | Page validation | As a CI gate I reject thin or fabricated landing markdown | `validate` checks frontmatter, lengths, FAQ count, body words, density, digits, em-dash/emoji, fabricated claims, all-token keyword presence | passing | test/validate.test.js › validate-page | existing |
| frontmatter | Frontmatter parse | As all consumers I split/parse YAML frontmatter consistently | `splitFrontmatter`/`parseFrontmatter` report matched, return body, surface YAML errors, default to `{}` | passing | test/frontmatter.test.js › frontmatter | new |
| date-helpers | Date helpers | As tracking/PR naming I format dates and ISO weeks | `subDays`, `format` (YYYY-MM-DD), `isoWeek` (YYYY-Www) compute correctly | passing | test/date.test.js › date-helpers | new |
| keywords-slug | Slug validation | As FS safety I only accept well-formed LLM slugs | `KEYWORD_STATUS` enum is stable; `isValidSlug`/`SLUG_REGEX` accept `a-z0-9-` starting alnum, reject the rest | passing | test/keywords.test.js › keywords-slug | new |
| keywords-store | Keyword state store | As the pipeline I persist and query the keyword backlog | load (missing→empty, bad JSON throws), save (writes + `updated`), upsert (insert/merge), getPending (status+score), saveLastPR | passing | test/keywords.test.js › keywords-store | new |
| landings | Existing landings | As discovery I skip slugs/titles already on disk | `getExistingSlugs` reads the locale dir with default-locale fallback; `getExistingTitles` prefers headline/title then filename | passing | test/landings.test.js › landings | new |
| sitefetch-strip | HTML to text | As site analysis I strip HTML to plain text | `stripHtml` removes script/style/comments/tags, decodes entities, collapses whitespace | passing | test/site-fetch.test.js › sitefetch-strip | new |
| sitefetch-pages | Fetch pages | As site analysis I fetch many URLs and drop failures | `fetchPages` returns only ok responses, truncates oversize bodies, swallows errors | passing | test/site-fetch.test.js › sitefetch-pages | new |
| detect-project | Project detection | As `seo init` I auto-detect repo/landing/style/locale/clusters/domain | `detectProject` returns hints from git remote, landing dirs, style docs, lang dirs, frontmatter clusters, public domain | passing | test/detect.test.js › detect-project | new |
| projects-discover | Project discovery | As the dashboard I find every project with a `seo.config.yaml` | `discoverProjects` walks roots, ignores vendor dirs, dedupes, skips unparseable configs, sorts by dir | passing | test/projects.test.js › projects-discover | new |
| dashboard-summary | Project summary | As the dashboard I aggregate funnel, backlog, rankings, suggestions per project | `projectSummary` counts statuses, builds backlog ≥cutoff, derives movers/snapshot from CSVs, emits suggestions | passing | test/dashboard.test.js › dashboard-summary | new |
| generate-page | Page generation | As generate I turn a keyword into validated markdown | `generatePage` rejects bad slugs, strips a wrapping code fence, replaces CANONICAL_URL/BASE_URL/SITE_NAME, calls Opus via `MODELS.generate` | passing | test/generate.test.js › generate-page | new mocks claude |
| pr-create | Open PR | As pr I commit generated pages and open a GitHub PR | `createPR` assembles files + keywords + sitemap-pending, dedupes sitemap slugs (shared `localeUrlPath`), injects hreflang for multi-locale, builds the PR body | passing | test/pr.test.js › pr-create | new mocks github |
| track-merge | Merge ranking CSV | As tracking I append today's snapshot idempotently | `mergeRankingCsv` keeps the header, drops prior same-day rows, preserves other days | passing | test/track.test.js › track-merge | new |
| track-run | Track rankings | As tracking I write GSC page/query performance to a weekly CSV | `track` writes `seo/rankings/<week>.csv`, auto-rotates to `<week>-partN.csv` when over the size cap then writes fresh | passing | test/track.test.js › track-run | new mocks gsc |
| discover-run | Discover keywords | As discover I score GSC candidates and fall back to greenfield | `discover` proposes scored GSC keywords, tops up via greenfield when below the cap, marks merged pages done, warns on exhausted SerpAPI quota | passing | test/discover.test.js › discover-run | new mocks gsc/serp/claude |
| claude-complete | Claude completion | As all LLM callers I get text or parsed JSON with retries | `complete` returns trimmed text, extracts fenced/bare JSON, throws on no/malformed JSON, rethrows non-retryable errors, defaults to `MODELS.default` | passing | test/claude.test.js › claude-complete | new mocks SDK |
| github-commit | GitHub commit/PR | As pr I create a branch commit and open a PR via the API | `createBranchAndCommit` builds blobs/tree/commit/ref and falls back to updateRef on 422; `openPR` returns the PR URL | passing | test/github.test.js › github-commit | new mocks octokit |
| check-cmd | Check command | As CI I validate already-generated markdown files | `checkCommand` errors with no files (exit 2), reports per-file errors, prints `SEO_CHECK_JSON`, exits 1 on failure | passing | test/check.test.js › check-cmd | new mocks exit |
| run-env | Run env guard | As the user I get a clear error when required env vars are missing | `runCommand` lists missing `ANTHROPIC_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`/`SERPAPI_KEY`/`GITHUB_TOKEN` and exits 1 | passing | test/run.test.js › run-env | new mocks exit |
| submitsitemap-cmd | Submit sitemap command | As the user I resubmit the sitemap to GSC with clear guard errors | `submitSitemapCommand` exits 1 when `gsc_property`/`base_url` missing, builds `<base>/sitemap.xml`, special-cases 403 | passing | test/submit-sitemap.test.js › submitsitemap-cmd | new mocks gsc/exit |
| dashboard-cmd | Dashboard command | As the user I get a cross-project overview or JSON | `dashboardCommand` exits 1 with no projects, filters by `--project`, prints aggregated JSON with `--json`, surfaces live-pull errors | passing | test/dashboard-cmd.test.js › dashboard-cmd | new mocks projects |
| gsc-auth-error | GSC auth hint | As the user I get an actionable message when my Google token expires | `describeAuthError` maps invalid_grant/expired-token failures to a re-auth/service-account hint and returns null for unrelated errors; GSC queries + sitemap submit rethrow with the hint | passing | test/gsc.test.js › gsc-auth-error | new |
| run-pipeline | Run pipeline orchestration | As the user `seo run` executes the full pipeline and recovers from PR failures | `runCommand` runs discover→generate→pr→track, records the PR url, rolls keyword status back to `proposed` on PR failure, retries generation once on validation failure (marks `validation_failed` after 2), caps concurrency at 2, skips pr/track on `--dry-run` | passing | test/run-pipeline.test.js › run-pipeline | new mocks steps |

## Needs human review

These have no meaningful automated check (interactive prompts, external auth/network, or subjective
LLM output quality). The orchestration that consumes them is covered at the step level via mocks.

- `seo init` interactive flow (`src/commands/init.js`): inquirer prompts, analysis-confirmation branch, manual-correction branch. Interactive; needs a human or a TTY harness.
- GSC auth + queries (`src/lib/gsc.js`): OAuth desktop browser flow, token caching, googleapis `searchanalytics`/`sitemaps` calls. External auth/network. (The `invalid_grant`/expired-token hint is now tested via `gsc-auth-error`.)
- Site analysis (`src/lib/analyze-site.js`): quality of the Claude-extracted topic/clusters/CTA/locale is subjective.
- Style-doc generation (`src/lib/generate-style-doc.js`): quality of the derived writing-style guide is subjective (path-traversal guard is the only mechanical bit).
- Dashboard ANSI rendering (`src/commands/dashboard.js` `renderProject`/`renderOverview`): cosmetic terminal output; the data layer (`dashboard-summary`) is tested.
