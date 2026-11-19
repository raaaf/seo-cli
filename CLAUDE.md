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
node bin/seo.js links         # give pages with fewer than 3 inbound links some via related_pages of on-topic pages (Haiku topic judge), one PR (--dry-run prints the plan)
node bin/seo.js dashboard     # cross-project overview (funnel, rankings, movers, suggestions)
node bin/seo.js dashboard --live  # same, but pull current positions/clicks from GSC
node bin/seo.js check <files...>  # validate already-generated landing markdown (CI gate)
node bin/seo.js verify <files...>  # independent second fact pass on a PR's pages (CI gate, strict projects; --commit --branch <ref>, --pr <n>, --report <path>; exit 3 = finding stands)
node bin/seo.js live-check <targets...>  # wait until pages are live (watch.check_deploy only; --head-ref, --wait <min>)
node bin/seo.js submit-sitemap    # (re)submit <base_url>/sitemap.xml to GSC
node bin/seo.js indexnow          # push all sitemap URLs to IndexNow (Bing, Yandex, Seznam, Naver)
node bin/seo.js index-status      # live Google index coverage per sitemap URL, diffed against last week
node bin/seo.js watch        # daily guard, no LLM: index status + traffic vs seo/alerts.json (--commit pushes alerts + index snapshot only if changed, --report <path>, --dry-run)
node bin/seo.js conversational    # group GSC queries into AI-Mode artefacts, tracker probes and real questions
```

`dashboard` is cross-project: it auto-discovers every project with a `seo.config.yaml` under `~/Local Sites` (override via `SEO_PROJECT_ROOTS`, colon-separated; linked git worktrees, recognised by a `.git` file, are skipped so a project shows once) and reads their committed state files. It does *not* run in the context of a single target project. Flags: `--live`, `--project <match>`, `--json`.

No build step. Tests: `npm test` (vitest, `test/*.test.js`). Filtered: `npx vitest run test/<file>.test.js` or `npx vitest run -t <name>`. During work run only affected tests; full suite only before push. Linting: `npm run lint` (eslint flat config). ESM (`"type": "module"`), Node 18+ for the CLI, Node 22.12+ for the tests (vitest 5).

## Architecture

This is a personal CLI that automates SEO landing page creation. It runs in the context of a *target project* (e.g. a Laravel or Vite site), not inside its own repo. `process.cwd()` always refers to the target project.

### Pipeline (`seo run`)

```
discover → generate → validate (up to 2 attempts) → fact-check → pr → track
```

All steps live in `src/steps/`. Orchestration is in `src/commands/run.js`: reconcile (keyword and improvement status against the real PR state via `getPR`), measure, discover, generate, `commitState` to main, one PR per keyword plus the rewrite PR, track. A `finally` block releases keywords that never got a PR, commits state again and writes the report, so a failed run keeps its status changes and budget count.

Per step and module: `discover` (`src/steps/discover.js`), `generate`, `validate`, fact-check (`review.js`), `verify`, `pr`, `improve`, `queue`, overlays, `measure`/`revert`, `track` are documented in `src/steps/CLAUDE.md`; inbound links, the watcher (`index-check`, `watch`, `diagnose`, `assess`), Bing, Rybbit, `conversational` and the key lib files table in `src/lib/CLAUDE.md`; the prompt templates, `{{icp}}` and own figures in `src/prompts/CLAUDE.md`.

## Critical rules

Short pointers; the full wording lives in the nested file named after each rule.

- `process.cwd()` is always the target project, never this repo (above).
- State files reach the target repo's default branch only through `commitState` (`src/lib/state.js`, `[skip ci]`), never through a PR branch; PR branches carry pages only (`src/steps/CLAUDE.md`, pr).
- Claude model ids live only in `MODELS` (`src/lib/models.js`); shared meta/tldr/body limits only in `SEO_THRESHOLDS` (`src/lib/seo-thresholds.js`) (`src/lib/CLAUDE.md`).
- Untrusted external data in prompts stays fenced (`<<<UNTRUSTED_*_START>>>`/`<<<UNTRUSTED_*_END>>>`), substitution is single-pass `fillTemplate`; optional blocks (`{{icp}}`, `{{facts}}`) leave the prompts byte-identical when absent (`src/prompts/CLAUDE.md`).
- `safeFetch` (`src/lib/safe-fetch.js`) is the SSRF guard for fetching site pages and endpoints; Rybbit calls `assertPublicUrl` itself because it needs its own request options (`src/lib/CLAUDE.md`).
- Bing and Rybbit errors carry fixed messages, never the URL or key (`src/lib/CLAUDE.md`, Signals).
- `BudgetExceededError` propagates; the run ends `budget_exceeded`, exit 0 (`src/lib/CLAUDE.md`, `budget.js`).
- Diagnosis and resubmit failures are warnings, never errors; `watch()` takes injectable `diagnose` and `submit` so tests stay off the network (`src/lib/CLAUDE.md`, watcher).
- During work run only affected tests; full suite only before push (Commands).

## State files (in target project, not this repo)

| Path | Purpose | Git |
|---|---|---|
| `seo/keywords.json` | Keyword backlog with statuses (`proposed`, `pr_opened` with `pr_url`, `published`, `rejected`, ...) | state commit to main |
| `seo/sitemap-pending.json` | Retired, no longer written; deleted on the next state commit (`RETIRED_STATE_FILES`) | state commit to main |
| `seo/rankings/YYYY-WW.csv` | Weekly ranking snapshots | gitignore |
| `seo/improvements.json` | Which pages were rewritten when, with the queries that drove it, `pr_url`, `merged_at`, `held` (`closed_at` when the owner closed the draft: it stays, the cooldown counts from that day, it is no open PR), `snippet`, `merge`/`prune`/`into`, `queue` (the prediction) | state commit to main |
| `seo/queue.json` | The queue of the last `seo run`: `type`, `slug`, `source`, `status`, `reason` per entry, no scores (those are in `report.queue`) | state commit to main |
| `seo/changes.json` | Change ledger: one entry per merged seo PR (`kind` new/rewrite/snippet/revert, `urls`, `merged_at`, `baseline`, readings `d28`/`d56`, `revert_candidate`, `revert`) | state commit to main |
| `seo/index-status.json` | Last week's Google index coverage per sitemap URL, for the weekly diff | state commit to main |
| `seo/budget.json` | SerpAPI searches, Anthropic API spend and subscription usage of the month | state commit to main |
| `seo/signals/bing.json` | Bing query cache (7 days, `queries:<site>`), only with `bing.enabled` | state commit to main |
| `seo/signals/rybbit.json` | Rybbit raw answer cache (7 days, `<site>:<endDate>:<kind>:<startDate>`), only with `rybbit.enabled` | state commit to main |
| `seo/signals/serp.json` | SERP signal cache (30 days) with AI Overview and other SERP features per keyword | state commit to main |
| `seo/alerts.json` | Watcher state: open alerts (with `diagnosis`, `resubmitted_at`, `assessment` on index alerts), `known_indexed`, traffic hysteresis, `deploy_pending` (only with `watch.check_deploy`), failure counter, `last_resubmit` | state commit to main |
| `seo/last-run.json` / `seo/runs.jsonl` | Last run report and the last 52 run summaries (`seo run`, `seo improve`) | state commit to main |

## .env loading order

`bin/seo.js` loads the CLI's own `.env` first (global API keys), then the target project's `.env` with `override: true` so project-level values win.

## Wegweiser (nested context files)

Path-bound rules live next to the code and load when a file there is read.

| File | Covers |
|---|---|
| `src/steps/CLAUDE.md` | Run/improve pipeline: discover, generate, validate, fact-check, verify, pr, improve, cluster guards, queue, page contract/catalog/overlays, recipe overlays, measure, revert, track, seasons, multi-locale, counterpart-locale |
| `src/lib/CLAUDE.md` | Inbound links, watcher (index-check, watch, ai crawlers, structured data, diagnose, assess, assessed rewrite, removal proposals), Bing, Rybbit, conversational, key lib files table |
| `src/prompts/CLAUDE.md` | Prompt templates, untrusted fences, score label eval set, `{{icp}}`, own figures (`{{facts}}`) |
