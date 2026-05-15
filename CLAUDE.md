# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/seo.js init          # interactive setup, writes seo.config.yaml in cwd
node bin/seo.js run           # full pipeline: discover + generate + PR
node bin/seo.js run --dry-run # preview generated markdown, no commit/PR
```

No build step. No test suite. ESM (`"type": "module"`), Node 18+.

## Architecture

This is a personal CLI that automates SEO landing page creation. It runs in the context of a *target project* (e.g. a Laravel or Vite site), not inside its own repo. `process.cwd()` always refers to the target project.

### Pipeline (`seo run`)

```
discover → generate → validate (up to 2 attempts) → pr → track
```

All steps live in `src/steps/`. Orchestration is in `src/commands/run.js`.

**discover** (`src/steps/discover.js`): Pulls the last 28 days of Search Console data (positions 8-25, filtered by `min_impressions`). Scores each candidate keyword via Claude + SerpAPI. Falls back to greenfield Claude suggestions when GSC data is sparse. Saves results to `seo/keywords.json` in the target project.

**generate** (`src/steps/generate.js`): Calls Claude Opus (`claude-opus-4-7`, 8000 tokens) with a prompt assembled from `src/prompts/generate.md` and a style doc. Outputs markdown with YAML frontmatter. Placeholders `CANONICAL_URL`, `BASE_URL`, `SITE_NAME` are replaced post-generation.

**validate** (`src/steps/validate.js`): Pure function, no I/O. Checks frontmatter fields, meta title/description lengths, FAQ count, body word count (800-1400), keyword density, entity coverage, em-dash/emoji, and fabricated-claim patterns. Returns `{ ok, errors, warnings }`. Up to 2 generation attempts per keyword.

**pr** (`src/steps/pr.js`): Commits all generated files plus `seo/keywords.json` and `seo/sitemap-pending.json` to a branch named `seo/YYYY-WW`, then opens a GitHub PR with an SEO check table in the body. Writes `seo/last-pr.json` for CI auto-merge workflows.

**track** (`src/steps/track.js`): Appends GSC page/query performance to `seo/rankings/YYYY-WW.csv`. Gitignored in target projects.

### Key lib files

| File | Role |
|---|---|
| `src/lib/claude.js` | Anthropic SDK wrapper. Singleton client, 4 retry attempts on 502/503/529. System prompt uses `cache_control: ephemeral`. |
| `src/lib/gsc.js` | Google Search Console via `googleapis`. Supports both service account and OAuth2 desktop app. Token cached at `~/.seo-cli-token.json`. |
| `src/lib/serpapi.js` | SerpAPI wrapper. Quota tracked in `~/.seo-cli-serpapi.json`, resets weekly. Hard stop at 240/week. |
| `src/lib/keywords.js` | Load/save/upsert `seo/keywords.json`. Defines `KEYWORD_STATUS` enum. |
| `src/lib/config.js` | Loads `seo.config.yaml` from cwd via `js-yaml`. |

### Prompts

`src/prompts/` contains markdown templates with `{{placeholder}}` substitution (simple `.replace()`, no templating engine):

- `score.md` — keyword scoring, returns JSON
- `greenfield.md` — keyword discovery without GSC data
- `generate.md` — full page generation (used with Opus)
- `style-default.md` — built-in writing style guide, used when `config.style_doc` is null

### State files (in target project, not this repo)

| Path | Purpose | Git |
|---|---|---|
| `seo/keywords.json` | Keyword backlog with statuses | commit |
| `seo/sitemap-pending.json` | Slugs queued for sitemap | commit |
| `seo/last-pr.json` | Last PR URL for CI | commit |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |

### Multi-locale support

When `config.locales` has more than one entry, `generateForLocale` runs for each locale. The `landing_path` is rewritten by substituting the locale segment (e.g. `/de/` to `/en/`). `pr.js` injects `hreflang` blocks into frontmatter for multi-locale pages.

### .env loading order

`bin/seo.js` loads the CLI's own `.env` first (global API keys), then the target project's `.env` with `override: true` so project-level values win.
