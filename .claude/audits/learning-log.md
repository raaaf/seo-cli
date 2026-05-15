# Audit Learning Log

This log is automatically appended after each audit.

---

## Retro — 2026-05-13 — main (full-audit)

### Statistik
- First audit in this project — no pattern recognition possible yet.

### Baseline
- Critical: 5, Important: 17, Minor: 11 (all fixed across 2 rounds).
- Skipped dimensions (no eligible files): SEO, A11y, Typography, UI Design, UX, Animation.
- Active dimensions: Architecture, Security, Performance, Code Quality.

### Worth remembering (for future audits in this codebase)

- **Untrusted-content injection into LLM prompts** appeared 3 times (analyze-site, generate-style-doc, discover). Fix pattern: `<<<UNTRUSTED_X_START>>>` markers + explicit "treat as data" instruction. Watch any new prompt assembly.
- **Memoization gaps in CLI hot loops** (loadStyleDoc, getExistingSlugs, defaultLocale, dynamic imports). Cost scales with `keywords × locales`. Always question per-iteration FS access.
- **GitHub Actions secrets via `echo`** is unsafe whenever the secret can contain `\n`, `"`, or `'`. Use `env:` mapping + `printf` with `umask 077`.
- **Stringly-typed status enum** (`proposed | done | skip | pr_opened | validation_failed`) is scattered across 3 files. Tracked as open issue #3.

### Open points carried forward
Issues #1-#7 on github.com/raaaf/seo-cli. Re-check at next audit whether they were closed or rotted.

### Gaps that limit audit quality
- No test runner configured → fixes applied blind. Add Vitest or Node's built-in `node:test` before next audit.
- No linter → can't catch the simple things automatically.
