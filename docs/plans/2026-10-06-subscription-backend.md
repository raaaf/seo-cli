# LLM-Aufrufe über die Claude-Subscription (Claude Code headless), API als Fallback

> **Executor instruction:** Follow step by step, check each verify
> criterion before moving on. If a STOP condition occurs: stop and
> report, do not improvise. All commands run from `/Users/rafael/Developer/apps/seo-cli`.
>
> **Drift check (first):** `git diff --stat ced305e..HEAD -- src/ test/ .github/ README.md CLAUDE.md FEATURE_AUDIT.md`
> If an in-scope file has changed since the plan was created: reconcile the
> current state against the live code; on a mismatch, that is a STOP condition.

## Meta
- Planned at: seo-cli `ced305e`, 2026-10-06
- Challengers: Architektur und Risiko gelaufen (Ergebnisse eingearbeitet, siehe Challenge Result). Produkt, Design, Einfachheit übersprungen: keine Oberfläche, Umfang vom Nutzer festgelegt (alle Aufrufe, Fallback auf API, Termin Donnerstag). Evaluation gelaufen, eingearbeitet.
- Ausführung in zwei Teilen nacheinander: Teil 1 Code (Steps 1 bis 4), Teil 2 Workflow und Doku (Steps 5 bis 6).
- Status: Spec

## Problem
Jeder seo-cli-Lauf bezahlt Claude nach Tokens über `ANTHROPIC_API_KEY` (Testlauf rafaelalex.de 2026-10-06: 1,95 USD für 20 Aufrufe). Der Nutzer hat eine Max-Subscription. Die Doku nennt `claude setup-token` ausdrücklich "for CI pipelines, scripts", gültig ein Jahr, für Pro und Max (https://code.claude.com/docs/en/authentication#generate-a-long-lived-token). seo-cli ruft Claude heute nur über `@anthropic-ai/sdk` auf (`src/lib/claude.js:153`), damit geht das nicht.

## Goal
- `complete()` läuft standardmäßig über `claude -p` mit `CLAUDE_CODE_OAUTH_TOKEN`, wenn der Token gesetzt ist.
- Jeder Fehler auf dem Subscription-Pfad führt zum bestehenden API-Pfad für diesen Aufruf. Limit, Auth-Fehler und Timeout schalten den Prozess dauerhaft auf die API (Limits einer Modellfamilie nur für diese Familie).
- Die Signatur von `complete()` bleibt, kein Aufrufer ändert sich. Neu ist nur die optionale Option `backend: 'api'`.
- Fallbacks sind in Log, Bericht und Mail sichtbar.
- Messbar: Im nächsten Wochenlauf bleibt `anthropic.usd` in `seo/budget.json` unverändert, `report.llm.subscription_calls` > 0, `report.llm.fallbacks` leer.

## Non-Goals
- Keine Änderung an Prompts oder Pipeline-Logik.
- Kein Batch über die Subscription.
- Keine Messung des Wochenlimits (keine API dafür).

## Out of Scope (Files)
- Aufrufer von `complete()`: `src/steps/{discover,review,generate,improve,counterpart}.js`, `src/lib/{analyze-site,generate-style-doc}.js`.
- `src/prompts/*`, Projekt-Repos, n8n (Steps 7 bis 10, Orchestrator).
- 1Password-Block im Workflow (`seo-reusable.yml:60-68`).

## Solution

### Approach
**Neues Modul `src/lib/claude-code.js`** mit `completeViaClaudeCode({ system, prompt, model, maxTokens, schema, webSearch, maxSearches })` und `ClaudeCodeError` (`kind: 'limit' | 'auth' | 'timeout' | 'error'`, dazu `family: 'opus' | 'sonnet' | null` bei einem Familienlimit). Es startet `claude -p` als Kindprozess:
- Argumente: `--output-format json --model <id> --system-prompt <system> --no-session-persistence --strict-mcp-config --setting-sources ""`.
- Ohne Websuche `--tools "" --max-turns 2`. Mit Websuche `--tools WebSearch --allowedTools WebSearch --max-turns <maxSearches + 2>`.
- `--effort high` für `MODELS.generate`, sonst kein Effort-Flag (wie im API-Pfad heute).
- `--json-schema <JSON>` wenn `schema` gesetzt, Ergebnis aus `structured_output`.
- Prompt über stdin.
- Arbeitsverzeichnis: neues leeres Temp-Verzeichnis pro Aufruf, danach gelöscht.
- Umgebung als Allowlist, sonst nichts: `PATH`, `HOME` und `CLAUDE_CONFIG_DIR` (beide auf das Temp-Verzeichnis), `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS=<maxTokens>`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DISABLE_AUTOUPDATER=1`. Insbesondere kein `ANTHROPIC_API_KEY` (würde laut Doku in `-p` den Token übersteuern), kein `GITHUB_TOKEN`, kein `SERPAPI_KEY`, kein GSC-Pfad. `--bare` ist nicht möglich, es liest den OAuth-Token nicht.
- Timeout 8 Minuten, dann Kindprozess beenden, `kind: 'timeout'`.

Auswertung der JSON-Ausgabe (Felder laut Spike in der Appendix):
- `is_error: true`, Exit-Code ungleich 0 oder nicht parsebare Ausgabe → `ClaudeCodeError`. Die Art kommt aus dem Text in `result`: `/You've hit your (session|weekly) limit|spend limit/i` → `limit`; `/You've hit your (Opus|Sonnet) limit/i` → `limit` mit `family`; `/OAuth|authenticat|Not logged in|Login expired|Invalid API key/i` → `auth`; sonst `error` (auch 429 und `subtype: error_max_turns`).
- `stop_reason: 'max_tokens'` oder `'refusal'` → `kind: 'error'` (wie `assertNotTruncated`/`assertNotRefused`, `src/lib/claude.js:54-68`).
- Schema gesetzt, aber `structured_output` fehlt → `kind: 'error'`.
- Erfolg: `{ text, structured, costUsd }` mit `costUsd = total_cost_usd`.

**`complete()` in `src/lib/claude.js`:**
- JSON-Extraktion (heute inline `:217-225`) wird ein benannter Helper mit exakt denselben Fehlermeldungen (`src/steps/review.js:21-23` erkennt sie per Regex). Beide Pfade nutzen ihn.
- Backend-Wahl pro Aufruf: Subscription nur, wenn `CLAUDE_CODE_OAUTH_TOKEN` gesetzt ist, `claude` im PATH liegt, `SEO_LLM_BACKEND` nicht `api` ist, die Option `backend` nicht `'api'` ist, kein dauerhafter Schalter für dieses Modell gesetzt ist und seit Prozessstart weniger als 60 Minuten vergangen sind. Sonst API wie heute.
- `batch` wird auf dem Subscription-Pfad ignoriert. Die Prüfung "batch + webSearch wirft" (`:157`) bleibt für beide Pfade.
- Bei `ClaudeCodeError`: Fallback auf den API-Pfad für diesen Aufruf. Bei `limit` ohne `family`, `auth` und `timeout` dauerhafter Schalter für alle Modelle, bei `limit` mit `family` nur für diese Familie. Nach Ablauf der 60 Minuten läuft der API-Fallback mit `batch: false`, damit der Job unter `timeout-minutes: 120` (`.github/workflows/seo-reusable.yml:42`) bleibt.
- Modulzustand: `getLlmStats()` liefert `{ subscription_calls, api_calls, usd_equivalent, fallbacks: [{ model, kind, reason }] }`. `resetLlmState()` für Tests (Schalter, Startzeit, Zähler).
- Jeder Fallback schreibt einmal eine Zeile `::warning::seo-cli fell back to the API (<kind>)` auf stdout. Das macht ihn in GitHub Actions sichtbar.

**Budget (`src/lib/budget.js`):** Subscription-Aufrufe buchen in `subscription: { calls, usd_equivalent }` (aus `costUsd`) und werden nicht gegen `usd_per_month` geprüft. `freshBudget` (`:25-27`) und die Normalisierung in `loadBudget` (`:42-46`) bekommen den Abschnitt. Die API-Grenze gilt unverändert für Fallbacks.

**Bericht (`src/commands/run.js`):** Im `finally` (`:393-406`) neben `budgetSummary` steht `report.llm = getLlmStats()`. Ist `fallbacks` nicht leer, kommt eine Zeile in `report.warnings`. Liegt `usd_equivalent` über 25 USD (laut Kalibrierung etwa 1 % des Wochenlimits), ebenfalls eine Warnung.

### Teil 1: Code
1. `src/lib/claude-code.js`. → verify: `npx vitest run test/claude-code.test.js`, Spawn an der I/O-Grenze gemockt. Ein Test pro Fall: Argumente ohne Tools; mit Websuche (`--tools WebSearch`, `--max-turns`); mit Schema (`--json-schema`, Rückgabe aus `structured_output`); `--effort high` nur für `MODELS.generate`; Umgebung enthält genau die Allowlist-Schlüssel (insbesondere kein `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `SERPAPI_KEY`); `CLAUDE_CODE_MAX_OUTPUT_TOKENS` gleich `maxTokens`; Arbeitsverzeichnis und `CLAUDE_CONFIG_DIR` sind ein Temp-Verzeichnis, nicht `process.cwd()`; Session-Limit → `limit` ohne Familie; Opus-Limit → `limit` mit `family: 'opus'`; Auth-Text → `auth`; `error_max_turns` → `error`; Exit-Code ungleich 0 → `error`; `stop_reason: max_tokens` und `refusal` → `error`; Schema ohne `structured_output` → `error`; Timeout → `timeout`.
2. `src/lib/budget.js`: Abschnitt `subscription`, Buchungsfunktion ohne Grenzprüfung. → verify: `npx vitest run test/budget.test.js`, inklusive Round-Trip von `subscription` durch `loadBudget` und angepasstem Test für die frische Datei (`test/budget.test.js:19`).
3. `src/lib/claude.js`: JSON-Helper, Backend-Wahl, Fallback, Schalter, 60-Minuten-Frist, `getLlmStats`, `resetLlmState`, Option `backend`. → verify: `npx vitest run test/claude.test.js`. `beforeEach` löscht `CLAUDE_CODE_OAUTH_TOKEN` und `SEO_LLM_BACKEND` und ruft `resetLlmState()`, die 29 bestehenden Tests bleiben unverändert grün. Neue Tests: Subscription-Pfad mit Token; ohne Token API; `SEO_LLM_BACKEND=api` und `backend: 'api'` erzwingen die API; `claude` fehlt im PATH → API, Warnung einmal; `error` → dieser Aufruf API, nächster wieder Subscription; `limit`/`auth`/`timeout` → alle weiteren Aufrufe API; Opus-Limit → nächster Opus-Aufruf API, Sonnet-Aufruf weiter Subscription; nach 60 Minuten (Zeit gemockt) API mit `batch: false`; batch + webSearch wirft auch mit Token; Subscription-Aufruf bucht in `subscription`, nicht in `anthropic`; `getLlmStats` zählt beide Pfade und Fallbacks; JSON-Helper liefert dieselben Fehlermeldungen wie heute.
4. `src/commands/run.js`: `report.llm`, Warnungen für Fallbacks und Nutzung über 25 USD. → verify: `npx vitest run test/run-pipeline.test.js`, Tests für `report.llm` im Bericht, Warnung bei Fallback, Warnung über 25 USD.

### Teil 2: Workflow und Doku
5. `.github/workflows/seo-reusable.yml`:
   - Optionales Secret `CLAUDE_CODE_OAUTH_TOKEN` unter `secrets:`. Den 1Password-Block nicht anfassen.
   - Job-Env `HAVE_CC_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}` nach dem Muster von `HAVE_OP_TOKEN` (`:56`).
   - Schritt "Install Claude Code" mit `if: env.HAVE_CC_TOKEN == 'true'`: `npm install -g @anthropic-ai/claude-code@2.1.292`.
   - `CLAUDE_CODE_OAUTH_TOKEN` in der env von "Run seo". `ANTHROPIC_API_KEY` bleibt gesetzt, er ist der Fallback (`REQUIRED_ENV` in `src/commands/run.js:41-42`).
   - Notify-Payload (`:374-378`) um `llm: ($report.llm // null)` ergänzen.
   → verify: `actionlint .github/workflows/seo-reusable.yml` ohne Befund
6. README und CLAUDE.md: Abschnitte "Required repo secrets" (README `:136-141`), "Run report" (`:213`) mit `llm`, "SerpAPI quota and budget" (`:224`) und Zeile `budget.json` (`:189`) mit `subscription`; Backend-Wahl, Fallback-Regeln, Token gültig ein Jahr, Rotation (`claude setup-token`, Secret in jedem Repo neu setzen). CLAUDE.md: Zeile zu `claude.js` (`:67`), neue Zeile `claude-code.js`, Budget-Zeile. `FEATURE_AUDIT.md`: neue Zeile `claude-code-backend` mit Test-ID im `describe`, Zeilen `claude-complete` und `run-report` anpassen. → verify: `grep -n "CLAUDE_CODE_OAUTH_TOKEN" README.md CLAUDE.md` mit Treffern, `grep -n "claude-code-backend" FEATURE_AUDIT.md test/claude-code.test.js` mit Treffern in beiden

### Nach dem Merge (Orchestrator, mit Zustimmung des Nutzers)
7. Nutzer erzeugt den Token mit `! claude setup-token`. Orchestrator setzt ihn als Secret in `raaaf/portfolio-2025`, `rafaelalex-dev/events`, `rafaelalex-dev/zeit` und ergänzt dort die Weitergabe in `.github/workflows/seo.yml`.
8. n8n "SEO: Trigger GitHub Workflows" (`wrN2WbFoNPAMbhAP`): Donnerstag 13:00 Europe/Berlin, 30 Minuten Abstand zwischen den Repos. n8n "SEO: Notify" (`5YM2niVBSDPtbADs`): Betreff mit "(Fallback auf API)", wenn `llm.fallbacks` nicht leer ist.
9. Vergleich: Fact-Check für 5 veröffentlichte Seiten von portfolio-2025 einmal mit `SEO_LLM_BACKEND=api` und einmal mit Token. Befunde vergleichen. Übersieht die Subscription High-Befunde, bekommt `src/steps/review.js` eine Zeile `backend: 'api'` (eigener kleiner PR). Dazu ein Sentinel-Test: eine `CLAUDE.md` mit auffälliger Anweisung in Projekt und `~/.claude` darf das Ergebnis nicht verändern.
10. Ein Lauf von Hand für portfolio-2025: `report.llm.subscription_calls` > 0, keine Fallbacks, `anthropic.usd` unverändert.

### Affected Files
- Teil 1: neu `src/lib/claude-code.js`, `test/claude-code.test.js`; geändert `src/lib/claude.js` (`:54-68`, `:153-238`), `src/lib/budget.js` (`:25-27`, `:42-46`), `src/commands/run.js` (`:393-406`), `test/claude.test.js`, `test/budget.test.js`, `test/run-pipeline.test.js`
- Teil 2: `.github/workflows/seo-reusable.yml`, `README.md`, `CLAUDE.md`, `FEATURE_AUDIT.md`

### Conventions
- Mocks nur an I/O-Grenzen: `child_process.spawn` in `test/claude-code.test.js`, SDK wie heute (`test/claude.test.js:6-22`).
- Fehlerklasse mit `kind` nach dem Muster von `BudgetExceededError` (`src/lib/budget.js`).
- Modell-IDs nur aus `src/lib/models.js`.
- Andere Tests mocken `claude.js` mit nur `complete`. Kein gemocktes Modul darf `getLlmStats` importieren außer `run.js`, und dort muss der Mock in `test/run-pipeline.test.js` es bereitstellen.

## Edge Cases
- `claude` fehlt im PATH: API, Warnung einmal pro Lauf.
- Token abgelaufen: `auth`, alles über die API, Mail mit "(Fallback auf API)".
- Zwei parallele Generierungen (`src/commands/run.js:325`): Buchung ist synchron, Schalter gelten sofort für beide.
- Fact-Check findet über die Subscription weniger: Step 9 entscheidet, Fallback per `backend: 'api'`.
- Lokaler Lauf ohne Token: API wie heute.

## Known Costs
- Zwei Backends in `claude.js`, mehr Tests.
- Fallbacks kosten API-Geld, gedeckelt durch `usd_per_month`.
- Wochenlimit der Subscription wird mitbenutzt (Warnung über 25 USD Gegenwert pro Lauf).
- Kein Pin des seo-cli-Checkouts in CI: Die Projekte nutzen bewusst `@main`. Stattdessen Rotationsanleitung für den Token.

## Done Criteria
Teil 1:
- [ ] `npx vitest run test/claude-code.test.js test/claude.test.js test/budget.test.js test/run-pipeline.test.js` → exit 0
Teil 2:
- [ ] `actionlint .github/workflows/seo-reusable.yml` → keine Befunde
- [ ] `grep -n "CLAUDE_CODE_OAUTH_TOKEN" README.md CLAUDE.md` → Treffer in beiden
Beide:
- [ ] `npm run lint` → exit 0
- [ ] `git status --short -- src test .github README.md CLAUDE.md FEATURE_AUDIT.md`: nur Dateien aus Affected Files

## STOP Conditions
- Eine Änderung an einem Aufrufer von `complete()` wäre nötig.
- Die 29 bestehenden Tests in `test/claude.test.js` brauchen inhaltliche Änderungen (nicht nur `beforeEach`).
- Verify schlägt nach ernsthaftem Fix zweimal fehl.
- Der aktuelle Stand weicht von den genannten Zeilen ab.

## Open Questions
- Limit- und Auth-Erkennung beruhen auf dokumentierten Meldungstexten. Ändert sich der Wortlaut, wird ein Limit als `error` erkannt. Der Fallback greift trotzdem, nur pro Aufruf statt dauerhaft.

## Challenge Result
Konsolidierung: 15 Einwände (Architektur 7, Risiko 8), 11 nach Dedupe, dazu 8 Punkte aus der Evaluation.
- **Übernommen (Architektur + Risiko):** Zeitbudget mit 8 Minuten pro Aufruf, dauerhafter Timeout-Schalter, 60-Minuten-Frist.
- **Übernommen (Architektur + Risiko):** Familienlimits nur für die Familie dauerhaft.
- **Übernommen (Architektur + Risiko):** Zähler über `getLlmStats()`, Fallback sichtbar in Log, Bericht, Payload und Mail.
- **Übernommen:** `stop_reason`, `maxTokens` als Env, Budget-Normalisierung, benannter JSON-Helper, Env-Allowlist, leeres `CLAUDE_CONFIG_DIR`, Auto-Memory und Updater aus, Fact-Check-Vergleich, Nutzungswarnung.
- **Übernommen:** Compliance belegt (`claude setup-token` für "CI pipelines, scripts").
- **Übernommen (Evaluation):** Approach widerspruchsfrei neu geschrieben, Option `backend: 'api'` statt Änderung an `review.js`, Notify-Payload mit `llm`, Reihenfolge Budget vor `claude.js`, Testliste pro Fall, Test-Hygiene mit `resetLlmState`, Install-Schritt nur mit Token, 1Password-Block unberührt, Doku-Stellen benannt, Teilung in zwei Teile.
- **Abgelehnt:** Erste Woche `require_review` für alle Projekte: Step 9 deckt das Qualitätsrisiko ab, der Nutzer will keine manuellen Schritte.
- **Abgelehnt:** seo-cli-Checkout pinnen: siehe Known Costs.

## Delegate spec

## Task: seo-cli Subscription-Backend, Teil 1 (Code)
**Goal:** `complete()` nutzt mit `CLAUDE_CODE_OAUTH_TOKEN` `claude -p`, fällt auf die API zurück, Schalter und Frist wie im Approach, Budget und Bericht getrennt. Done Criteria "Teil 1" und "Beide" grün.
**Context:** Repo `/Users/rafael/Developer/apps/seo-cli` @ `ced305e`, Plan `docs/plans/2026-10-06-subscription-backend.md`, Abschnitte Approach und Teil 1, Spike in der Appendix.
**Affected files:** Affected Files, Teil 1.
**Out of Scope:** Aufrufer von `complete()`, `src/prompts/*`, Teil 2, Projekt-Repos, n8n.
**Steps:** 1 bis 4 in dieser Reihenfolge, jeweils mit dem genannten verify.
**Done criteria (all):** Teil 1 und Beide. Nur gefilterte Tests.
**STOP conditions:** siehe STOP Conditions.

## Task: seo-cli Subscription-Backend, Teil 2 (Workflow und Doku)
**Goal:** Workflow installiert Claude Code nur mit Token, reicht den Token an "Run seo", Payload mit `llm`; Doku vollständig. Done Criteria "Teil 2" und "Beide" grün.
**Context:** setzt Teil 1 voraus. Plan wie oben, Abschnitt Teil 2.
**Affected files:** Affected Files, Teil 2.
**Out of Scope:** Code aus Teil 1, 1Password-Block, Projekt-Repos, n8n.
**Steps:** 5 bis 6.
**Done criteria (all):** Teil 2 und Beide.
**STOP conditions:** siehe STOP Conditions.

## Appendix
Spike am 2026-10-06, Claude Code 2.1.292, lokal mit Subscription-Login, `ANTHROPIC_API_KEY` entfernt, Arbeitsverzeichnis `mktemp -d`.

- **Schema:** `claude -p --output-format json --model claude-sonnet-5-5 --system-prompt ... --no-session-persistence --strict-mcp-config --setting-sources "" --tools "" --max-turns 1 --json-schema '{...}'` → `subtype: success`, `is_error: false`, `structured_output: {"count": 3}`, `result` enthält dasselbe als String, `num_turns: 2`, `total_cost_usd: 0.005`.
- **Websuche:** `--tools WebSearch --allowedTools WebSearch --max-turns 6` → `success`, Antwort mit Quellen. `usage.server_tool_use.web_search_requests` steht dabei auf 0 (Claude Code führt die Suche selbst aus), Kosten nur über `total_cost_usd`.
- **Zu wenig Turns:** `--max-turns 1` mit Websuche → `subtype: error_max_turns`, `is_error: true`, `terminal_reason: max_turns`, `result: null`.
- **Felder der JSON-Ausgabe:** `type, subtype, is_error, result, structured_output, total_cost_usd, usage, modelUsage, num_turns, terminal_reason, api_error_status, stop_reason, session_id, duration_ms, permission_denials` und weitere.
- **Isolation:** `--setting-sources ""` lädt laut `claude --help` keine Nutzer-, Projekt- oder lokalen Einstellungen; Managed Settings und `--settings` gelten weiter. `--tools ""` deaktiviert alle Tools.
- **Fehlertexte** (https://code.claude.com/docs/en/errors, im JSON-Modus als Text in `result`, keine strukturierten Codes): "You've hit your session limit · resets ...", "You've hit your weekly limit · resets ...", "You've hit your Opus limit ...", "You've hit your monthly spend limit ...", "API Error: Request rejected (429) ...", "OAuth token has expired", "OAuth token revoked", "Failed to authenticate: ...", "Not logged in · Please run /login", "Invalid API key".
