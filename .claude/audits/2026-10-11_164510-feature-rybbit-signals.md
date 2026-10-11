# Audit: feature/rybbit-signals

Scope: 21 files (Rybbit client, signal adapter, run/improve/measure/assess wiring, workflow, docs). Review: code_review high on the branch (complete). Sensitive: none.

## Findings
- [code_review] Important rybbit.js:93 plain 4xx trip the failure guard. fix.
- [code_review] Important measure.js:131 partial rybbit readings never refilled. fix.
- [code_review] Important run.js:441, improve call sites: Rybbit throws can abort the run. fix (try/catch, warning).
- [code_review] Minor signals/rybbit.js:190 sequential requests. discard: few calls on small sites, guard bounds failures.
- [code_review] Minor rybbit.js:60 fixed Europe/Berlin. discard: all projects are German.
- [code_review] Minor rybbit.js:28 duplicate of bing.js guard. discard: shared helper is a separate refactor.
- [code_review] Minor seo-reusable.yml:160 key loaded in watch mode. fix.
- [code_review] Minor README missing Rybbit. fix.
- [code_review] Important signals/rybbit.js:203 goals cache key without paths. fix.
- [code_review] Minor improve.js:225 prototype slug lookup. fix.
- [pre-check] DOCSCLAIM CLAUDE.md:26 placeholder path. discard.

## Tests
npx vitest run: 67 files, 1003 passed. Lint 0.
