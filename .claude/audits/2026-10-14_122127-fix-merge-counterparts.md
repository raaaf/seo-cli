# Audit: fix/merge-counterparts

Scope: landings.js buildMergeFiles, improve.js PR body, improve-cmd tests, CLAUDE.md. Review: code_review high (complete).

## Findings
- [code_review] Minor landings.js:165 survivor without counterpart leaves stale related_pages. fix: entry dropped.
- [code_review] Important landings.js:140 shared/survivor alternate deleted. fix: survivor alternate skipped, alternates deduped.
- [code_review] Important landings.js:148 prefixed counterpart URLs miss the redirect. fix: no redirect written with counterpart_url_prefix, PR body asks for a manual one.
- [code_review] Minor improve.js:330 PR body omits counterparts. fix.
- [code_review] Important landings.js:136 unvalidated alternate path. fix: isValidSlug.
- [code_review] Minor landings.js:140 stale survivor alternate. discard: improve keeps the counterpart slug (fixedSlug).
- [code_review] Minor tests gaps. fix: one test per guard, two guards mutation-checked.

## Tests
npx vitest run: full suite green. Lint 0.
