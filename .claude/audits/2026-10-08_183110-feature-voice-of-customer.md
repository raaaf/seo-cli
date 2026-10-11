# Audit feature/voice-of-customer (seo-cli)

Base fba23d8. Reviews: code_review (high). Pre-checks clean.

## Findings
- Minor generate.js:117 read errors threw: fixed. Minor generate.js:117 UTF-16 cut without marker: fixed. Minor config.js:81 null could not disable: fixed. Minor discover.js:328 greenfield without icp: fixed. Minor discover.js:409 optional cwd: fixed (required). Minor improve.md:50 block without heading: fixed.
- Discarded: cache lifetime (one-shot CLI), review/counterpart without icp (out of plan scope), two cache mechanisms.

## Tests
- npm test green, lint clean.
