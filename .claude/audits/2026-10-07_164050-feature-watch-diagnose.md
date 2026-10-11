# Audit feature/watch-diagnose

Base 1346db2, 20 files, DIFF_CLASS=code. Reviews: code_review (high). Sensitive checklist: not run (no sensitive paths).

## Pre-checks
- [pre-check] SECRET_SCAN CLEAN, LOCKFILE_DRIFT CLEAN, BINARY_ARTIFACTS CLEAN, SILENCING OK.
- [pre-check] CI_HARDENING 4 hits (seo-reusable.yml:69,71,77,101): discard, pre-existing lines not touched by this diff.
- [pre-check] DOCSCLAIM CLAUDE.md:26 template path, CLAUDE.md:141 scan bound: discard, pre-existing.

## Findings
- [code_review] Important src/lib/diagnose.js:88 redirect check ignored slash/www redirects: fixed (plain href comparison).
- [code_review] Important src/lib/diagnose.js:89 X-Robots-Tag bot prefix and data-* attributes gave false noindex: fixed.
- [code_review] Important src/lib/diagnose.js:79 fetch error message dropped, redirect loop not technical: fixed.
- [code_review] Important src/steps/diagnose.js:39 one alert could take all 10 URL slots: fixed (round-robin).
- [code_review] Important src/steps/assess.js:110 empty model result saved, blocking 28 days: fixed (treated as failure).
- [code_review] Minor src/steps/assess.js:104 no_text pages assessed: fixed (skipped with warning).
- [code_review] Minor CLAUDE.md:111 em-dash: fixed.
- [code_review] src/steps/watch.js:38 resubmitted_at never cleared: discard, once per alert is the documented plan decision (Edge Cases).
- [code_review] src/lib/diagnose.js:12 spoofed Googlebot UA: discard, documented tradeoff; 401/403/429 map to unknown.
- [code_review] src/lib/diagnose.js:56 body buffering and runtime: discard, at most 11 fetches with 10 s timeout per daily run.

## Tests
- npm test: 51 files, 620 passed. npm run lint: exit 0.
