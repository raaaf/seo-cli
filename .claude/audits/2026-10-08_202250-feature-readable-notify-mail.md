# Audit: feature/readable-notify-mail

Scope: 7 files (assess prompt/step/tests, run/watch report site, workflow payload, CLAUDE.md). Reviews: code_review high (complete). Sensitive: none.

## Findings
- [code_review] Important assess.md:22 prompt says "4 weeks" without today's date. fix: `Today: {{today}}`.
- [code_review] Minor improve.js report lacks site. fix (partial): CLAUDE.md scoped to run/watch, siteInfo helper; improve standalone is not wired to the notify mail.
- [code_review] Important assess.js:80 revert candidates listed as done. fix: marker plus prompt exception.
- [code_review] merged_at raw string compare. discard: changes.js stores YYYY-MM-DD only.
- [code_review] Minor catch returns "none". fix: "unknown (change history unreadable)".
- [code_review] recent_changes outside loop try. discard: loadChanges is inside its own try/catch, cannot throw out.
- [code_review] Minor German text caps. fix: 300/300/450.
- [code_review] Minor test gaps. fix: tests for revert marker and corrupt file.
- [pre-check] CI_HARDENING 7 hits on untouched lines. discard: pre-existing.
- [pre-check] DOCSCLAIM CLAUDE.md:26 placeholder path. discard.

## Tests
npx vitest run: 65 files, 921 passed. Lint 0.
