# seo-cli

Automated SEO landing page pipeline. Discovers keyword opportunities via Google Search Console, generates pages with Claude, validates them, and opens a pull request.

## How it works

```
seo run
  ├── discover   GSC + SerpAPI + Claude scoring
  ├── generate   Claude writes markdown (prose + YAML frontmatter)
  ├── validate   structure, word count, entities, tone checks
  └── pr         commits to branch, opens PR
```

You review and merge the PR. That's the only manual step.

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
      GSC_CREDENTIALS: ${{ secrets.GSC_CREDENTIALS }}
      GSC_TOKEN: ${{ secrets.GSC_TOKEN }}
```

**Required repo secrets:**
| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SERPAPI_KEY` | SerpAPI key (free tier: 250/month) |
| `GSC_CREDENTIALS` | Google OAuth2 credentials JSON |
| `GSC_TOKEN` | GSC auth token JSON |

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
min_impressions: 5      # min GSC impressions to consider a keyword
clusters:
  - event-planning
  - party-organization
```

## State files (per project)

| File | Description | Git |
|---|---|---|
| `seo/keywords.json` | Keyword backlog and status | commit |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |
| `seo.config.yaml` | Project config | commit |

Add to `.gitignore`:
```
seo/rankings/
```

## Supported project types

The CLI generates markdown with YAML frontmatter. The exact schema depends on the project:

- **events / zeit (Laravel):** `steps`, `faq`, `checklist`, `related_features`, `related_pages` as structured YAML — rendered by Blade components
- **rafaelalex.de (Vite static):** full markdown body — converted to HTML at build time

Configure `landing_path` and `locale` in `seo.config.yaml` to match your project.

## SerpAPI quota

Free tier: 250 searches/month. The CLI tracks usage in `~/.seo-cli-serpapi.json` and shows remaining quota at the start of each run. Hard stop at 240 to keep a buffer.

## License

MIT
