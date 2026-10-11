# Audit: 2026-10-06: Branch: refactor/etappe-a1-fundament

## Scope
- Base: 8701955646aaf331c7ec20cb42fb49c9cdb4c739 | HEAD at audit time: 41a02c7 (fixes committed as b98075b)
- Changed files: 36 | Diff class: code
- Reviews run: code_review

## Pre-checks
- check-ci-hardening: HITS (4), actions pinned to tags in seo-reusable.yml:59,61,67,91 (pre-existing)
- check-silencing: HITS (2), src/steps/pr.js:70, src/commands/improve.js:138
- check-docs-claims: FINDINGS (1), CLAUDE.md:25 placeholder path

## Result
- Gate: passed
- Findings: Critical 0 / Important 5 / Minor 7 | Fixed 9 | Discarded 3 | Open 0
- Tests: npm test, 41 files, 402 tests passed
- Kosten dieses Laufs: 2.35 USD (ca. 0.1 % der Woche), Woche ca. 118.7 % (lokale Schätzung über die Sessions auf diesem Mac; genauer Wert: /usage)

## Findings
- [Important][code_review] .github/workflows/seo-reusable.yml:109: a failed Run seo step skipped index-status and Gate, PRs opened before the failure were never gated
- [Important][code_review] src/commands/run.js:243: in-place merged_at update invisible to the change check, never persisted
- [Important][code_review] src/commands/run.js:338: keywords committed as pr_opened without pr_url before PRs exist, stuck after a hard kill
- [Important][code_review] src/commands/run.js:332: Promise.all rejected early, siblings booked cost after the state commit
- [Important][code_review] src/steps/discover.js:225: BudgetExceededError swallowed by generic catches (discover, review, counterpart), improve could open a PR without fact check
- [Minor][code_review] src/lib/github.js:143: getBlobShas ignored a truncated tree
- [Minor][code_review] .github/workflows/seo-reusable.yml:132: em-dashes in added lines
- [Minor][code_review] src/lib/budget.js:49: config and budget file re-read before every paid call
- [Minor][pre-check] src/steps/pr.js:70: empty catch on branch cleanup
- [Minor][pre-check] src/commands/improve.js:138: empty catch on branch cleanup
- [Minor][pre-check] .github/workflows/seo-reusable.yml:59: actions pinned to tags, not SHAs
- [Minor][pre-check] CLAUDE.md:25: docs claim references placeholder path

## Fixed
- [Important][code_review] .github/workflows/seo-reusable.yml:109: index-status and Gate run with if: always()
- [Important][code_review] src/commands/run.js:243: explicit change flag, test pins merged_at persistence
- [Important][code_review] src/commands/run.js:338: pre-PR commit stores awaiting keywords as proposed, pr_opened only with pr_url
- [Important][code_review] src/commands/run.js:332: Promise.allSettled, BudgetExceededError rethrown after all tasks settled
- [Important][code_review] src/steps/discover.js:225: rethrowIfBudget in discover, review and counterpart catches, tests added
- [Minor][code_review] src/lib/github.js:143: truncated tree throws
- [Minor][code_review] .github/workflows/seo-reusable.yml:132: em-dashes replaced in added lines
- [Minor][pre-check] src/steps/pr.js:70: cleanup failure logged and reported as warning
- [Minor][pre-check] src/commands/improve.js:138: cleanup failure logged and reported as warning

## Discarded
- [Minor][code_review] src/lib/budget.js:49: a few dozen paid calls per run, the extra file reads are negligible
- [Minor][pre-check] .github/workflows/seo-reusable.yml:59: tag pinning predates this branch, not part of the diff
- [Minor][pre-check] CLAUDE.md:25: intentional placeholder in the filtered test command

## Minor, not fixed

## Not completed

## Open Points
