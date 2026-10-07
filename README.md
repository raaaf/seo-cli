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
| `seo improve [--dry-run]` | Rewrite the existing page with the strongest case, from live GSC data |
| `seo check <files...>` | Validate already-generated landing-page markdown (CI gate) |
| `seo dashboard [--live] [--project <name>] [--json]` | Cross-project overview: funnel, rankings, movers, suggestions |
| `seo submit-sitemap` | (Re)submit `<base_url>/sitemap.xml` to Google Search Console |
| `seo indexnow` | Push all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver), using the `indexnow_key` config key |

A local `seo run` without `--dry-run` commits the machine state (see below) straight to `main` as well, so run `git pull` afterwards.

`dashboard` is cross-project: it auto-discovers every project with a `seo.config.yaml` under `~/Local Sites` (override via `SEO_PROJECT_ROOTS`, colon-separated).

## Automation (GitHub Actions)

Use the reusable workflow. Each project only needs its own GSC secrets.

### Option A: with 1Password

Store `ANTHROPIC_API_KEY` and `SERPAPI_KEY` in 1Password at `op://development/seo-cli/`.

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
score_cutoff: 7         # 0–10, keywords below this are skipped
weekly_cap: 2           # max pages generated per run
max_new_pages_per_month: 4  # new-page PRs per calendar month, rewrites do not count
min_impressions: 5      # min GSC impressions to consider a keyword
greenfield: false       # invent keywords when GSC yields none. Off by default:
                        # an empty backlog means the topic space is covered
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

## State files (per project)

The machine state goes straight to `main` (commit message `seo: state (<reason>) [skip ci]`), never into a PR: `seo run` commits it before the PRs are opened and once more afterwards, also when the run found nothing to do or failed half way. PRs carry pages only.

| File | Description | Way |
|---|---|---|
| `seo/keywords.json` | Keyword backlog and status | state commit to `main` |
| `seo/sitemap-pending.json` | Slugs queued for sitemap submission, added when a keyword's PR is merged | state commit to `main` |
| `seo/improvements.json` | Which page was rewritten when, the queries behind it, its PR url and merge date | state commit to `main` |
| `seo/index-status.json` | Last week's Google index coverage per sitemap URL | state commit to `main` |
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

### Run report

`seo run --report <path>` writes `{ status, prs: [{ url, kind: 'new'|'improve', slug }], budget, llm, warnings, errors }`. `llm` is `{ subscription_calls, api_calls, usd_equivalent, fallbacks: [{ model, kind, reason }] }`; a non-empty `fallbacks` and a `usd_equivalent` above 25 USD (roughly 1 percent of the weekly Max limit) each add a warning. `status` is `idle`, `prs_opened`, `failed` or `budget_exceeded` (exit code 0). The workflow gates every PR of the report and ends with a notify step that always runs and posts `{ repo, run_url, status, prs: [{ url, gate_status }], budget, llm, warnings, errors }` to `SEO_NOTIFY_WEBHOOK`. `--dry-run` skips the reconcile, the state commits and the PRs, and still writes the report.

## Supported project types

The CLI generates markdown with YAML frontmatter. The exact schema depends on the project:

- **events / zeit (Laravel):** `steps`, `faq`, `checklist`, `related_features`, `related_pages` as structured YAML — rendered by Blade components
- **rafaelalex.de (Vite static):** full markdown body — converted to HTML at build time

Configure `landing_path` and `locale` in `seo.config.yaml` to match your project.

## SerpAPI quota and budget

SerpAPI searches and Anthropic spend are counted per project and calendar month in `seo/budget.json` and checked before every paid call. The limits come from `budget:` in `seo.config.yaml` (default 30 USD and 60 searches per month, so up to four projects stay under the shared 250/month free tier). Once per process the free `account.json` endpoint is read as well: with no searches left on the account the run stops, whatever the project budget says. Failed requests refund their reservation. Calls on the Claude subscription cost no API money: they are tallied under `subscription` (`calls`, `usd_equivalent`) and not checked against the limit, while API fallbacks are. A run that hits a limit ends with status `budget_exceeded` and exit code 0.

## License

MIT
