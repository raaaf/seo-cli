# Audit: feature/assess-fresh-context

Scope: assess step/prompt/tests, run.js waiting list, workflow fetch-depth and payload, CLAUDE.md. Review: code_review high (complete). Sensitive: none.

## Findings
- [code_review] Important assess.js:80 stored lastCrawlTime lags. fix: live inspect of the alert URLs before waiting.
- [code_review] Important assess.js:72 global last change. fix: per alert URL, global only for site_not_indexed.
- [code_review] Important assess.js:107 git log -n 60 before filter. fix: -n 300, filter, cap 30.
- [code_review] Important assess.js:92 extension filter drops .html. fix: asset extension list.
- [code_review] Important assess.js:187 home fetch failure silent. fix: warning plus marker line.
- [code_review] Minor assess.js:194 silent truncation. fix: cut marker.
- [code_review] Minor date-only compare on merge day. discard: merged_at has no time, a same-day crawl may precede the merge.
- [code_review] Minor lastChangeDate null without warning. discard: recentChanges already warns on an unreadable ledger.
- [code_review] Important assess.md:32 links and commits unfenced. fix: UNTRUSTED fences (fillTemplate sanitizes all values).
- [code_review] Minor test gaps. fix: tests for live gate, per-alert, commit filter, asset filter, home failure.

## Tests
npx vitest run: 65 files, 931 passed. Lint 0.
