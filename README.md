# seo-cli

Automated SEO landing page pipeline. Discovers keyword opportunities via Google Search Console, generates pages with Claude, validates them, and opens a pull request.

## How it works

```
seo run
  ├── discover     GSC + SerpAPI + Claude scoring, duplicates rejected
  │                 └── backlog empty? → improve an existing page instead
  ├── generate     Claude writes markdown (prose + YAML frontmatter)
  ├── validate     structure, word count, entities, tone checks
  ├── fact-check   claims verified against the live web, corrections applied
  └── pr           one PR per keyword (all locales and the counterpart)
```

A new page is only written when Search Console shows demand for a topic no
published page answers. When there is none, the run rewrites the existing page
with the strongest case instead: a page ranking well without clicks has a title
problem, a page just off page one has a content gap. An empty backlog is a
normal result, not a failure.

You review and merge the PRs. That's the only manual step.

## Setup

### 1. Install

```bash
npm install -g raaaf/seo-cli   # or clone and npm link for local dev
```

### 2. Configure the project

Run in the project directory:

```bash
seo init
```

This fetches the site URL, analyzes existing pages and copy, and writes `seo.config.yaml`. You confirm or correct the detected values.

### 3. Set environment variables

Copy `.env.example` to `.env` and fill in:

```env
ANTHROPIC_API_KEY=sk-ant-...
SERPAPI_KEY=...
GITHUB_TOKEN=ghp_...              # classic token, repo scope
GOOGLE_APPLICATION_CREDENTIALS=/path/to/oauth2-credentials.json
```

**Google credentials:** Create an OAuth2 Desktop App credential in Google Cloud Console, enable the Search Console API, download the JSON. On first `seo run` a browser opens for authorization — the token is saved to `~/.seo-cli-token.json` and reused automatically.

### 4. Run

```bash
seo run            # discover + generate + open PR
seo run --dry-run  # preview without committing
```

## Commands

| Command | Description |
|---|---|
| `seo init` | Interactive setup, writes `seo.config.yaml` in the current project |
| `seo run [--dry-run] [--report <path>]` | Full pipeline: reconcile status with the real PR state, discover, generate, validate, fact-check, one PR per keyword. Improves an existing page when the backlog is empty. `--report` writes the run report as JSON |
| `seo watch [--commit] [--report <path>] [--dry-run]` | Daily guard without an LLM: index status plus landing page traffic against `seo/alerts.json`. Open index alerts get a technical diagnosis (live fetch as Googlebot plus the last Google crawl), and a clean one resubmits the sitemap and IndexNow at most every 7 days. Reports (`status: alert`/`resolved`) only what opens, changes diagnosis or resolves, `watch_ok` otherwise. `--commit` pushes only `seo/alerts.json` and `seo/index-status.json`, only when they changed |
| `seo improve [--dry-run]` | Rewrite the existing page with the strongest case, from live GSC data |
| `seo links [--dry-run]` | Gives every landing page with fewer than 3 inbound links up to 3, as `related_pages` entries on on-topic pages (code checks eligibility, Haiku judges the topic, one call per page). One PR on `seo/links/<week>`. New-page and improve PRs do the same for their own page; `inbound_links: false` turns that off |
| `seo check <files...>` | Validate already-generated landing-page markdown (CI gate) |
| `seo verify <files...> [--commit --branch <ref>] [--pr <n>] [--report <path>]` | Independent second fact pass (gate, `quality: strict` projects only, others print `skipped`): recomputes derived numbers, needs the statute wording for law claims and the vendor's own page for third-party prices. Patches what it can (`--commit` pushes the patch to the PR branch and prints `VERIFY_HEAD_SHA=<sha>`), writes its findings into the PR body between `<!-- seo-verify:start -->` and `<!-- seo-verify:end -->` (`--pr`), exits 3 while a finding stands |
| `seo live-check <targets...> [--head-ref <ref>] [--wait <minutes>]` | Waits until pages answer like a deployed page (URLs, or the PR's changed files with `--head-ref`); only with `watch.check_deploy`, otherwise it passes at once. Exit 1 when still not live |
| `seo dashboard [--live] [--project <name>] [--json]` | Cross-project overview: funnel, rankings, movers, suggestions |
| `seo submit-sitemap` | (Re)submit `<base_url>/sitemap.xml` to Google Search Console |
| `seo indexnow` | Push all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver), using the `indexnow_key` config key |

A local `seo run` without `--dry-run` commits the machine state (see below) straight to `main` as well, so run `git pull` afterwards.

`dashboard` is cross-project: it auto-discovers every project with a `seo.config.yaml` under `~/Local Sites` (override via `SEO_PROJECT_ROOTS`, colon-separated).

## Automation (GitHub Actions)

Use the reusable workflow. Each project only needs its own GSC secrets.

### Option A: with 1Password

Store the shared fields (`ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `GSC_CREDENTIALS`, `GSC_TOKEN`, `SEO_NOTIFY_WEBHOOK`, `CLAUDE_CODE_OAUTH_TOKEN`, `BING-WEBMASTER-API`, `RYBBIT_API_KEY`) in 1Password at `op://development/seo-cli/`. The service account behind `OP_SERVICE_ACCOUNT_TOKEN` needs read access to that vault.

```yaml
# .github/workflows/seo.yml
name: SEO
on:
  schedule:
    - cron: '17 11 * * 3'   # weekly, jittered
  workflow_dispatch:
jobs:
  seo:
    uses: raaaf/seo-cli/.github/workflows/seo-reusable.yml@main
    secrets:
      OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
      GSC_CREDENTIALS: ${{ secrets.GSC_CREDENTIALS }}
      GSC_TOKEN: ${{ secrets.GSC_TOKEN }}
```

**Required repo secrets:**
| Secret | Description |
|---|---|
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password service account token |
| `GSC_CREDENTIALS` | Google OAuth2 credentials JSON (contents of file) |
| `GSC_TOKEN` | GSC auth token JSON (contents of `~/.seo-cli-token.json`) |

**Optional secret:** `SEO_NOTIFY_WEBHOOK` receives one report per run (see Run report). Without it the run ends with a visible `::warning::`.

**Optional input:** `op_vault` (under `with:`, default `development`) names the 1Password vault of the shared `seo-cli` item. Every vault supplies `ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `GSC_CREDENTIALS`, `GSC_TOKEN`, `SEO_NOTIFY_WEBHOOK` and `CLAUDE_CODE_OAUTH_TOKEN` from `op://<op_vault>/seo-cli/<FIELD>`, so the item must carry the Google pair; a repo secret of the same name wins, and the caller then needs only `OP_SERVICE_ACCOUNT_TOKEN`. The webhook and the Claude token load in a separate non-fatal step, so a field that is not in the item yet does not stop the run. `GSC_CREDENTIALS` and `GSC_TOKEN` are no longer `required` secrets: the Google step fails with a clear message when neither a secret nor 1Password delivers them. `mode: watch` loads only the Google pair, the webhook and the Bing key.

**Optional input:** `mode: watch` (under `with:`, default `run`) runs the daily guard instead of the pipeline: checkout, Google credentials, `seo watch --commit --report`, notify. From 1Password it loads only the Google pair, the webhook and the Bing key; no LLM or SerpAPI key, no Claude Code, no run, no gate. Expose it as a `workflow_dispatch` input and run it daily from the scheduler (n8n triggers it at 07:00, `mode=run` on Thursdays). The seo-cli checkout has no `ref`: the `@main` pin in the project fixes only the workflow file, the code is always `main`.

**Gate verify:** per PR the gate runs `seo check`, then `seo verify --commit` (it skips itself on projects that are not `quality: strict`), then `seo check` again when verify moved the PR head. A finding that stands, a failed push or a patch that breaks `seo check` ends in the gate status `fact_blocked` and no merge, also under `require_review`. The merge is `gh pr merge --match-head-commit <verified sha>`, so a head that moved after the check is never merged. For projects with `watch.check_deploy` the gate polls the page URL (`seo live-check`, at most 12 minutes) before it submits the sitemap and IndexNow. The gate step needs `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and the job `timeout-minutes` is 135. Caveat: a push with `GITHUB_TOKEN` triggers no PR workflow, so a project with PR CI would end in `checks_timeout` after a verify patch (no project has PR CI today). `page_contract.forbidden_claims` (regexes, always an error, no catalog needed) is the deterministic twin: positioning phrases and product claims the product cannot keep; zeit mirrors its `LandingProductClaimsTest` and `LandingBrandSpellingTest` there, change both together. Eval: `node test/eval/verify-history.mjs` (real API, not part of `npm test`).

**Optional input:** `require_review: true` (under `with:`) disables auto-merge
entirely — every generated PR stays open and is reported as `needs_review`.
Use it for repos where the generated prose itself is the risk: CI can gate
tests, only a human can gate content.

### Option B: direct secrets (no 1Password)

```yaml
# .github/workflows/seo.yml
name: SEO
on:
  schedule:
    - cron: '17 11 * * 3'
  workflow_dispatch:
jobs:
  seo:
    uses: raaaf/seo-cli/.github/workflows/seo-reusable.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      SERPAPI_KEY: ${{ secrets.SERPAPI_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      GSC_CREDENTIALS: ${{ secrets.GSC_CREDENTIALS }}
      GSC_TOKEN: ${{ secrets.GSC_TOKEN }}
```

**Required repo secrets:**
| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SERPAPI_KEY` | SerpAPI key (free tier: 250/month) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional. Long-lived Claude subscription token from `claude setup-token`; LLM calls then run on the subscription instead of the API (see below) |
| `GSC_CREDENTIALS` | Google OAuth2 credentials JSON |
| `GSC_TOKEN` | GSC auth token JSON |

### Claude subscription backend

With `CLAUDE_CODE_OAUTH_TOKEN` set, `complete()` runs every call through `claude -p` (Claude Code headless) on the subscription instead of the Anthropic API. The workflow installs Claude Code (`@anthropic-ai/claude-code@2.1.292`) only when the secret is present. `ANTHROPIC_API_KEY` stays required: it is the fallback.

- **API is used** when the token is unset, `claude` is not in `PATH`, `SEO_LLM_BACKEND=api` is set, or the call passes `backend: 'api'`.
- **Fallback:** any error on the subscription path repeats that one call on the API. A session/weekly/spend limit, an auth error (expired or revoked token) or a timeout (8 minutes per call) switches all further calls of the process to the API. A limit of one model family (Opus or Sonnet) switches only that family. Other errors (max turns, truncated or refused output, bad JSON) fall back for that call only.
- **60-minute window:** one hour after process start every call goes to the API, with batching off, so the job stays inside its 120-minute timeout.
- **Visibility:** each fallback prints `::warning::seo-cli fell back to the API (<kind>)` and appears in `report.llm.fallbacks` and in the report warnings.
- Subscription calls are booked in `seo/budget.json` under `subscription` and are not checked against `usd_per_month`; fallbacks are.
- Batch generation is ignored on the subscription path.

Setup: run `claude setup-token` locally (Pro or Max login), set the output as `CLAUDE_CODE_OAUTH_TOKEN` secret in every project repo and pass it through in the caller workflow as shown above. The token is valid for one year. To rotate it, run `claude setup-token` again and replace the secret in every repo.

Local runs use the subscription only when `CLAUDE_CODE_OAUTH_TOKEN` is set in the environment; without it they use the API as before. Set `SEO_LLM_BACKEND=api` to force the API.

## seo.config.yaml

```yaml
project: events
repo: owner/repo
gsc_property: https://events.example.com/
base_url: https://events.example.com
site_name: events
landing_path: resources/landing/de/
locale: de
locales: [de]           # [de, en] for bilingual
primary_cta: trial_signup
style_doc: null         # null = built-in default style
icp_doc: seo/icp.md     # audience document, optional: missing file = prompts unchanged, injected as {{icp}} (max 8000 chars)
score_cutoff: 7         # 0–10, keywords below this are skipped
weekly_cap: 2           # max pages generated per run
max_new_pages_per_month: 4  # new-page PRs per calendar month, rewrites do not count
min_impressions: 5      # min GSC impressions to consider a keyword
greenfield: false       # invent keywords when GSC yields none. Off by default:
                        # an empty backlog means the topic space is covered
seasons: []             # [{ name, peak: 'MM-DD', lead_weeks: 10, keywords: [], pages: [slug] }]
                        # inside the lead window discover seeds keywords, improve rewrites pages first
fact_check: true        # verify claims against the live web before committing
counterpart_locale: null  # e.g. 'en' — also generate a reciprocal counterpart
                           # page per default-locale page, own slug, sharing the
                           # bare /{slug} URL space, linked via `alternate:`
counterpart_url_prefix: '' # e.g. '/en' — when the counterpart site serves its
                            # pages under a path segment instead of the bare
                            # /{slug} URL space
batch_generation: true  # generate via the Message Batches API at half price,
                         # falling back to an interactive call if it stalls
budget:                  # per project and calendar month, checked before every
  usd_per_month: 30      # paid call, counted in seo/budget.json
  serpapi_per_month: 60
clusters:
  - event-planning
  - party-organization
```

### Shop projects: page contract, catalog, overlays

All of these are optional. Without them every rule above stays as it was.

```yaml
catalog_url: https://shop.example.com/seo/catalog.json  # machine-readable catalog, the fact source
page_contract:                    # project rules on top of the landing format
  body_words: [300, 600]          # replaces the 800-1400 range (both bounds are errors)
  require: [products]             # extra required frontmatter fields
  forbid: [steps, checklist]      # fields that must not appear
  products: { min: 3, max: 8, max_overlap: 0.6 }  # slugs from the catalog; share shared with any existing page
  lowercase: true                 # hero, tldr, headings, FAQ, meta in lowercase
  meta_title_suffix: " . brand"   # the site appends this; meta_title max shrinks by its length
  facts_denylist: ['\\d+\\s*(€|eur)']  # regexes that fail unless the catalog states the match word for word
reserved_slugs: [admin, cart]     # one-segment paths the site already serves, never used as a slug
overlays:                         # shop meta and intro per product / category, see below
  products: content/seo/products
  categories: content/seo/categories
watch: { check_deploy: true }     # not_deployed alert for merged pages and overlays (opt-in); also ai_crawlers, structured_data (both default true), ai_crawlers_ignore: [tokens]
bing: { enabled: true }           # Bing Webmaster as a second signal (opt-in, needs BING_WEBMASTER_KEY), see below
```

**Bing** (`bing.enabled`, optional `bing.site_url` when Bing knows the site under another URL than `base_url`): Bing feeds ChatGPT search and Copilot, so it is both an AI-visibility check and a second signal; Search Console stays the main source. The key is `BING_WEBMASTER_KEY` (workflow: `op://<op_vault>/seo-cli/BING-WEBMASTER-API`, a repo secret of the same name wins; without it Bing is skipped with a warning). `seo watch` checks `GetCrawlIssues` and `GetUrlInfo` for at most 10 sitemap URLs per day (Bing throttles `GetUrlInfo` after 10 per host; URLs never asked about first, then those seen uncrawled, two slots always recheck crawled ones; each group in a section that advances daily), keeps `bing.crawled` per URL in `seo/alerts.json` and opens `bing_crawl_issues` (issues on sitemap URLs, 2 days in a row) and `bing_site_not_crawled` (under 20 percent crawled with at least 5 judged URLs, 2 days in a row, resolves from 50 percent). `bing_blind` opens when the key is rejected or after 3 days without a successful Bing call; Bing trouble is never an error and never `watch_blind`. The index diagnosis adds `bing: { crawled }` to each diagnosed URL (a field, not a finding). `seo run` stores the filtered Bing queries (180 days, at most 200, no emails, long digit runs or phone numbers) in `seo/signals/bing.json` for 7 days: matching ones are added to the `people_also_ask` slot of the generate prompt, and in start mode (`greenfield: true`, fewer ready keywords than `weekly_cap`) queries at position 20 or better with at least `max(5, min_impressions)` impressions become candidates (`source: bing`) before greenfield invents any. Not used by `improve`, `measure` or `traffic_drop`.

**Rybbit** (`rybbit: { enabled, url, site_id, macro_goal, micro_goals }`): first-party analytics as a second signal on what visitors do after they land. `url` is the https base of the Rybbit instance, `site_id` its site, `macro_goal` the main goal by name, `micro_goals` optional side goals. The key is `RYBBIT_API_KEY` (workflow: 1Password field `RYBBIT_API_KEY` in `op://<op_vault>/seo-cli`, run mode only; without it Rybbit is skipped with a warning). Two failures in a row of unavailable, rate limited or rejected calls end the Rybbit calls of that process; a plain error (400/404) does not count. `seo run` reports the weekly window per landing page, `improve` boosts well-entered pages without conversions and `measure` stores the values in each reading. Raw answers are cached 7 days in `seo/signals/rybbit.json`.

**Catalog:** `loadCatalog` (`src/lib/catalog.js`) fetches `catalog_url` once per process (`safeFetch`, 10 s) and checks the shape (`version: 1`, `shipping`, `categories`, `products` with `slug`, `title`, `category`, `url`, `description`, `material`, `sizes`). `seo run` skips discover and generate with a warning while it is unreachable; `seo check` fails. The catalog goes into the generate and greenfield prompts together with the contract rules.

**Overlays:** a product or category page of the shop gets `meta_title`, `meta_description` and `intro` from `<overlays.products>/<slug>.md` or `<overlays.categories>/<key>.md` (frontmatter only, no body). `src/steps/overlay.js` writes them with Sonnet (`overlay.md`, JSON schema, batch unless disabled), validates them with `validateOverlay` (lengths, `intro` 40 to 120 words, category at most 60, lowercase, denylist, em-dash and emoji, target still in the catalog) and opens one PR per run on `seo/improve/product-<slug>` or `seo/improve/category-<key>`. Overlays do not count against `max_new_pages_per_month`. They use the improve slot: first a rewrite of a landing page, otherwise an overlay. Once GSC shows `/shop/` traffic the overlay page with the strongest case is rewritten (same scoring as landing pages). Before that (start mode: no GSC row with `/shop/` in the path in the last 28 days) a product without an overlay gets one, in catalog order. `improvements.json` and `changes.json` key overlays as `product:<slug>` and `category:<key>`; `urlToSlug` maps `/shop/<slug>` and `/shop?category=<key>` to those keys, and overlays are measured against overlay controls only.

## State files (per project)

The machine state goes straight to `main` (commit message `seo: state (<reason>) [skip ci]`), never into a PR: `seo run` commits it before the PRs are opened and once more afterwards, also when the run found nothing to do or failed half way. PRs carry pages only.

| File | Description | Way |
|---|---|---|
| `seo/keywords.json` | Keyword backlog and status | state commit to `main` |
| `seo/sitemap-pending.json` | Slugs queued for sitemap submission, added when a keyword's PR is merged | state commit to `main` |
| `seo/improvements.json` | Which page was rewritten when, the queries behind it, its PR url and merge date | state commit to `main` |
| `seo/changes.json` | Change ledger: every merged seo PR (new page or rewrite) with its merge date, baseline and the 28 and 56 day readings | state commit to `main` |
| `seo/index-status.json` | Google index coverage per sitemap URL, rewritten daily by `seo watch`; `updated` moves only when an entry does, and an `unknown` entry (quota) never replaces the previous one | state commit to `main` |
| `seo/alerts.json` | Watcher state: `open` alerts (`deindexed:<url>`, `site_not_indexed`, `traffic_drop`, `watch_blind`, `ai_crawler_blocked`, `structured_data`; index alerts carry `diagnosis`, `resubmitted_at` and, from `seo run`, `assessment`), `known_indexed` URLs, the traffic hysteresis, the failure counter, `last_resubmit`, and the pending counters of the crawler and structured data checks (`ai_crawlers.pending`/`ok_seen`, `structured_data.pending`) | state commit to `main` |
| `seo/last-run.json` | Report of the last `seo run` or `seo improve` (without the per-change lists) | state commit to `main` |
| `seo/runs.jsonl` | One line per `seo run`/`seo improve` (`date`, `mode`, `status`, `prs`, `llm`, `budget`, warning and error counts), last 52 | state commit to `main` |
| `seo/signals/bing.json` | Bing query cache (7 days, key `queries:<site>`), only with `bing.enabled` | state commit to `main` |
| `seo/signals/rybbit.json` | Rybbit answer cache (7 days, key `<site>:<endDate>:<kind>:<startDate>`), only with `rybbit.enabled` | state commit to `main` |
| `seo/signals/serp.json` | SERP signal cache (30 days): top results, related searches and SERP features such as AI Overview per keyword; a cache hit costs no SerpAPI search | state commit to `main` |
| `seo/budget.json` | SerpAPI searches, Anthropic API spend and subscription usage (`subscription: { calls, usd_equivalent }`) of the current month | state commit to `main` |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |
| `seo.config.yaml` | Project config | commit |

Add to `.gitignore`:
```
seo/rankings/
```

### Keyword status and PRs

Every keyword is its own PR on `seo/new/<slug>` (all locale files and the counterpart together), every rewrite is its own PR on `seo/improve/<slug>`. A branch that already exists means an earlier PR is still open: that keyword or page is skipped with a warning. The status on `main` follows the real PR state, reconciled at the start of every run:

| Status | Meaning |
|---|---|
| `proposed` | Scored, waiting for a PR (also after a failed PR) |
| `pr_opened` | PR open, `pr_url` stored on the entry |
| `published` | PR merged, its slugs are queued in `sitemap-pending.json` |
| `rejected` | PR closed without merge, the keyword is not proposed again |

A rewrite's cooldown entry is only written once its PR exists. A closed rewrite PR removes the entry, a merged one keeps it.

### Measurement

Every merged seo PR becomes an entry in `seo/changes.json` (`id` = PR url, `kind` `new` or `rewrite`, `urls` including a rewrite's counterpart). Only a real merge date from GitHub creates an entry; PRs merged (by merge date) in the last 90 days that have none yet are added retroactively, a PR that cannot be read is retried on the next run, and one that was read but never qualifies is listed under `skipped` and not read again. `seo run` then computes every due reading right after the reconcile (GSC queries only, no LLM, nothing is written on `--dry-run`).

- Windows (merge = merge date): baseline `merge-28` to `merge-1`, reading `d28` `merge+8` to `merge+35`, reading `d56` `merge+36` to `merge+63`. A reading is due once its window ended 3 days ago (GSC lag).
- Metrics per landing page: clicks, impressions, CTR, impression-weighted position. Only known landing pages count (homepage, pricing, blog are ignored); the counterpart prefix is stripped.
- New pages get their absolute values, no verdict (there is no before).
- Rewrites get a verdict `positive | neutral | negative | insufficient_data` against unchanged pages of the same language (no entry merged in `merge-28` to `merge+63`, counterparts included). Controls are pages between half and double the target's baseline impressions; with fewer than 12 of those, every page with at least 50. Per page `r = (after + 1) / (before + 1)` on clicks (target with at least 20 baseline clicks) or impressions. `positive` needs `r` above the controls' 90th percentile and at least 1.3 times their median, `negative` the mirror (10th percentile, at most 0.7 times).
- `insufficient_data` carries a reason: `volume` (target under 100 impressions before the change), `control` (fewer than 12 controls), `dispersion` (90th over 10th percentile above 4, e.g. a Google update), `overlap` (another change to the same page inside baseline or reading window; clusters are not detected), `missing` (the target had a baseline but no GSC row in the reading window, never read as zero). A target URL that maps to no landing page is marked `unmapped` and never measured; `d56` is only computed once `d28` exists.
- Two `negative` readings with an effect (`r` over the controls' median) of at most 0.7 in `d56` set `revert_candidate: true` and add a warning. Nothing is reverted automatically.
- The verdict is a hint, not proof: `improve` picks pages with an outlier in the data, so part of any later movement is regression to the mean. Small sites will see many `insufficient_data`.

### Run report

`seo run --report <path>` writes `{ status, prs: [{ url, kind: 'new'|'improve', slug }], measurement, budget, llm, warnings, errors }`. `measurement` is `{ entries, due, measured, verdicts, insufficient_by_reason, revert_candidates: [slug], changed: [{ slug, kind, reading, verdict }] }`: counts over the whole ledger and the readings computed in this run, not the ledger itself. `llm` is `{ subscription_calls, api_calls, usd_equivalent, fallbacks: [{ model, kind, reason }] }`; a non-empty `fallbacks` and a `usd_equivalent` above 25 USD (roughly 1 percent of the weekly Max limit) each add a warning. `status` is `idle`, `prs_opened`, `failed` or `budget_exceeded` (exit code 0). The workflow gates every PR of the report and ends with a notify step that always runs and posts `{ repo, run_url, status, prs: [{ url, gate_status }], budget, llm, warnings, errors }` to `SEO_NOTIFY_WEBHOOK`. `--dry-run` skips the reconcile, the state commits and the PRs, and still writes the report.

**Watcher alerts** (`seo watch`, no LLM, no SerpAPI): a `deindexed:<url>` alert opens for a URL that was once seen indexed and is not now, and resolves when it is indexed again. `site_not_indexed` opens when fewer than 20 percent of the sitemap URLs with a known verdict (at least 5) are indexed, also on the first snapshot, and resolves from 50 percent. `traffic_drop` compares landing page impressions of the last 7 complete days (ending today-3) with the 7 days before: it opens after 2 consecutive days with more than 40 percent loss (at least 200 impressions in the comparison window, otherwise `insufficient`, no alert) and resolves below 25 percent. A failed GSC or inspection check (also a `sitemap.xml` that answers an error or is no sitemap) leaves its alerts alone, lands in `errors` and makes the status `failed`; 2 failed runs in a row open `watch_blind`, which resolves on the first good run. A URL counts as indexed when the inspection verdict is `PASS`; `NEUTRAL` (noindex, redirect, other canonical) and `FAIL` (404, 5xx) count as not indexed. The watch report is `{ status: 'failed'|'alert'|'resolved'|'watch_ok', mode: 'watch', alerts: { opened, updated, resolved, resubmitted }, open_alerts, traffic, warnings, errors }`; the notify payload carries `mode` and `alerts`, and the mail routing should skip `watch_ok`. The watcher writes no run log.

**AI crawler access and structured data** (`seo watch`, no LLM, no key; switches `watch.ai_crawlers` and `watch.structured_data`, both on by default): `ai_crawler_blocked` opens when an AI search bot (OAI-SearchBot, PerplexityBot, Claude-SearchBot, Claude-User, ChatGPT-User, Perplexity-User) is turned away. Two sources: `robots.txt` (RFC 9309, judged for the first four against `/` and every sitemap path; opens at once) and a live fetch of the home page and one rotating page as that bot and as a browser (4xx/5xx including 402, or a Cloudflare challenge, while the browser gets 2xx; opens on the second run in a row). A live block counts only for a bot that was `ok` from this runner before (`ai_crawlers.ok_seen`), otherwise it is a warning, because a firewall that only hits spoofed user agents is no alert. Training bots (GPTBot, ClaudeBot, CCBot, Google-Extended) appear only in `report.ai_crawlers` (`robots`, `search`, `training`). `watch.ai_crawlers_ignore: [token]` leaves a deliberately blocked bot out. `structured_data` opens for landing pages, or every sitemap URL in a project without `landing_path` (up to 10 per day, rotating, plus every page with a finding), whose live HTML has no JSON-LD (`jsonld_missing`), an unparseable block (`jsonld_invalid`), an entity missing a field Google requires for its rich result (`required:Recipe.image`, `required:LocalBusiness.address`, ...; Recipe, LocalBusiness and subtypes, Product, Event, BreadcrumbList, VideoObject, SoftwareApplication, ProfilePage, WebSite), a robots `noindex` (`meta_noindex`) or a canonical naming another URL (`canonical_other`), on the second run in a row. `report.structured_data` is `{ checked, findings, recommended }`; `recommended` lists per page FAQ items in the frontmatter without a `FAQPage` type (`FAQPage`; Google dropped FAQ rich results in June 2026, so it is no alert any more), what Search Console mails as non-critical (e.g. `Recipe.recipeCategory`, `Recipe.recipeInstructions.url`) plus missing on-page signals (meta description, canonical, `html lang`, Open Graph, h1, and on the home page a WebSite and an Organization/Person entity). It never opens an alert. Both are aggregated alerts whose `detail` follows the current set (changes land in `alerts.updated`). All fetches share one pool (5 at a time, 60 s); what misses the deadline is unknown and changes nothing. Neither check counts towards `watch_blind`.

**Index diagnosis** (`seo watch`, no LLM): every open `deindexed`/`site_not_indexed` alert gets `diagnosis = { checked_at, cause, codes, urls }` from at most 10 URLs per run. A live fetch as Googlebot (10 s timeout) yields codes such as `not_found`, `redirect`, `noindex_header`, `noindex_meta`, `canonical_other`, `blocked_for_bot`; the Inspection API adds hints (`google_canonical_other`, `robots_blocked`, `soft_404`). `cause` comes from the live codes only: `technical`, `unknown` (5xx, firewall, failed fetch, missing inspection) or `clean`. An `unknown` result never replaces a diagnosis, a changed result needs two runs in a row, and `checked_at` moves only with `cause` or `codes`, so a quiet day makes no commit. A `clean` alert resubmits the sitemap to Google and, with `indexnow_key`, the URLs to IndexNow, once per run and at most every 7 days (`last_resubmit`); a dry run submits nothing. `seo run` then assesses `clean` alerts (`src/steps/assess.js`, Sonnet, at most 3 per run, every 28 days per alert) and stores `assessment = { assessed_at, likely_causes, actions }` as a recommendation; it rewrites nothing. The notify payload carries `assessments`.

## Supported project types

The CLI generates markdown with YAML frontmatter. The exact schema depends on the project:

- **events / zeit (Laravel):** `steps`, `faq`, `checklist`, `related_features`, `related_pages` as structured YAML — rendered by Blade components
- **rafaelalex.de (Vite static):** full markdown body — converted to HTML at build time

Configure `landing_path` and `locale` in `seo.config.yaml` to match your project.

## SerpAPI quota and budget

SerpAPI searches and Anthropic spend are counted per project and calendar month in `seo/budget.json` and checked before every paid call. The limits come from `budget:` in `seo.config.yaml` (default 30 USD and 60 searches per month, so up to four projects stay under the shared 250/month free tier). Once per process the free `account.json` endpoint is read as well: with no searches left on the account the run stops, whatever the project budget says. Failed requests refund their reservation. Results are cached for 30 days in `seo/signals/serp.json` and read before any of these checks, so a repeated keyword costs no search. Keywords whose SERP shows an AI Overview that is known not to cite the site (references present, our domain absent, judged against the current `base_url`) and whose intent is informational are worked off after comparable keywords (priority score minus 2, the stored score is unchanged; SERP snapshots older than 60 days are ignored). Calls on the Claude subscription cost no API money: they are tallied under `subscription` (`calls`, `usd_equivalent`) and not checked against the limit, while API fallbacks are. A run that hits a limit ends with status `budget_exceeded` and exit code 0.

## License

MIT
