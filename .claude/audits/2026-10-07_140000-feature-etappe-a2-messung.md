# Audit: 2026-10-07: Branch: feature/etappe-a2-messung

## Scope
- Base: 8caa12e | HEAD at audit time: b57e0ff (fixes 2211736)
- Changed files: 16 | Diff class: code
- Reviews run: code_review

## Pre-checks
- all clean

## Result
- Gate: passed
- Findings: Critical 0 / Important 3 / Minor 7 | Fixed 8 | Discarded 2 | Open 0
- Tests: npm test, 45 files, 515 tests passed

## Fixed
- [Important][code_review] src/lib/measure.js:143: volume gate only on the baseline, collapses become negative
- [Important][code_review] src/steps/measure.js:82: target missing in the reading window is insufficient_data (missing)
- [Important][code_review] src/steps/measure.js:37: unmappable URLs flagged, never measured as zeros
- [Minor][code_review] src/commands/run.js:258: skipped backfill PRs recorded, not re-read
- [Minor][code_review] src/commands/run.js:262: 90-day cutoff on the merge date
- [Minor][code_review] src/commands/run.js:262: existing published_at kept
- [Minor][code_review] src/commands/run.js:247: counterpart URL added once readable
- [Minor][code_review] src/steps/measure.js:95: d56 waits for d28

## Discarded
- [Minor][code_review] src/steps/measure.js:70: past GSC windows are final, baseline identical whenever fetched
- [Minor][code_review] src/steps/measure.js:52: weekly batch, parallel requests not worth it

## Open Points
