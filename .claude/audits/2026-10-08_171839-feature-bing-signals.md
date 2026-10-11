# Audit feature/bing-signals (seo-cli)

Base eb0f7aa, 27 files. Reviews: code_review (high). No sensitive paths.

## Pre-checks
- secrets, lockfile, binaries clean. CI_HARDENING tag pins: discard, repo convention. SILENCING test/bing-guard.test.js:34: discard, intentional catch before a call-count assertion. DOCSCLAIM: pre-existing.

## Findings
- Important src/steps/watch.js:171 one failing getUrlInfo aborted the Bing check: fixed (per URL).
- Important src/lib/watch.js:106 Bing alerts never close when Bing is off: fixed (`bing_disabled`).
- Important src/lib/signals/bing.js:90 empty query list refetched every run: fixed.
- Important src/steps/discover.js:127 start-mode candidates outside the GSC window: fixed (8-25).
- Minor src/commands/run.js:459 refresh when unused: fixed. Minor src/steps/diagnose.js:78 duplicate GetUrlInfo: fixed. Minor src/lib/signals/bing.js:34 missing position as 0: fixed. Minor src/steps/watch.js:140 duplicate normalisation: fixed.
- src/lib/watch.js:117 coverage over values of different age: discard, slow-moving, 5-URL minimum plus 2-day hysteresis.

## Minor, not fixed
- The mapping `bing.enabled: false` to `{ disabled: true }` in src/steps/watch.js:152 is covered only at evaluateWatch level, not by a step-level test.

## Tests
- npm test: 64 files, 896 passed; lint clean; oracle tests (16) unchanged; live smoke test against zeit (sites, crawl issues, URL info, queries, bad key without leak).
