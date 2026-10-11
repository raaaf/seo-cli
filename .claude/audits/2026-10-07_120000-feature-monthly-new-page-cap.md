# Audit: 2026-10-07: Branch: feature/monthly-new-page-cap

## Scope
- Base: 7d3c1e6aabb0e028c0a499369d6f9174c2e546e5 | HEAD at audit time: 957558a (fixes committed as ee63252)
- Changed files: 13 | Diff class: code
- Reviews run: code_review

## Pre-checks
- all clean (secrets, lockfile, binaries, silencing)

## Result
- Gate: passed
- Findings: Critical 0 / Important 1 / Minor 5 | Fixed 4 | Discarded 2 | Open 0
- Tests: npm test, 42 files, 462 tests passed
- Kosten dieses Laufs: 2.43 USD (ca. 0.1 % der Woche), Woche ca. 124.4 % (lokale Schätzung über die Sessions auf diesem Mac; genauer Wert: /usage)

## Findings
- [Important][code_review] src/commands/run.js:330: discover (SerpAPI and scoring) ran even with the monthly cap exhausted
- [Minor][code_review] src/commands/run.js:334: max_new_pages_per_month not validated
- [Minor][code_review] src/commands/run.js:228: legacy PRs without created_at queried on every run
- [Minor][code_review] src/commands/run.js:337: warning clamped the used count at the cap
- [Minor][code_review] src/commands/run.js:231: dry run skips reconcile, preview misses the cap
- [Minor][code_review] src/lib/keywords.js:57: cap counts PRs per keyword, not pages or publish month

## Fixed
- [Important][code_review] src/commands/run.js:330: cap computed before discover, discover skipped at 0
- [Minor][code_review] src/commands/run.js:334: invalid value falls back to the default with a warning
- [Minor][code_review] src/commands/run.js:228: pr_opened_at 'unknown' after one successful read
- [Minor][code_review] src/commands/run.js:337: warning uses the real count

## Discarded
- [Minor][code_review] src/commands/run.js:231: dry runs are previews and never touch GitHub state
- [Minor][code_review] src/lib/keywords.js:57: one PR is one topic (both locales ship together), counted by open month on purpose

## Minor, not fixed

## Not completed

## Open Points
