# Etappe A.1: Fundament (Stand, Budget, PR pro Aktion, Lebenszeichen)

> **Executor instruction:** Follow step by step, check each verify
> criterion before moving on. If a STOP condition occurs: stop and
> report, do not improvise. All commands run from `/Users/rafael/Developer/apps/seo-cli`.
>
> **Drift check (first):** `git diff --stat 860b86d..HEAD -- src/ test/ .github/ bin/`
> If an in-scope file has changed since the plan was created: reconcile the
> current state against the live code; on a mismatch, that is a STOP condition.

## Meta
- Planned at: seo-cli `860b86d`, 2026-10-06
- Teil von `docs/plans/2026-10-06-system-architecture.md`, Etappe A. Etappe A ist geteilt: A.1 (dieser Plan) baut die Infrastruktur, A.2 (eigener Plan) das Änderungsbuch und die Ergebnisbewertung.
- A.1 läuft in **zwei Teilen nacheinander**, je ein Executor: Teil 1 Infrastruktur (Steps 0 bis 5), Teil 2 Ablauf (Steps 6 bis 10). Teil 2 startet erst, wenn Teil 1 grün ist.
- Challengers: Architektur und Risiko liefen auf dem Architekturplan. Evaluation dieses Plans (Fakten und Vollständigkeit) lief, Ergebnisse sind eingearbeitet (siehe Challenge Result).
- Status: Spec

## Problem
Vier Fehler im heutigen Code, alle gegen HEAD geprüft:
1. **Stand geht verloren.** Der CI-Runner ist flüchtig. `seo/keywords.json` wird lokal geschrieben (`src/steps/discover.js:127`), aber nur committet, wenn ein PR entsteht (`src/commands/run.js:227`). Läufe mit Validierungsfehler, leerem Backlog oder fehlgeschlagenem PR verlieren alle Statusänderungen (`run.js:92-97`, `:198-203`, `:234-242`).
2. **SerpAPI-Kontingent greift in CI nicht.** Gezählt wird in `~/.seo-cli-serpapi.json` (`src/lib/serpapi.js:7`), die Datei überlebt keinen Lauf. Anthropic-Kosten werden gar nicht gezählt, `complete()` verwirft `usage` (`src/lib/claude.js:116-119`).
3. **Ein PR pro Woche fest verdrahtet.** Branches `seo/<woche>` (`src/steps/pr.js:13`) und `seo/improve-<woche>` (`src/commands/improve.js:97`). Existiert der Branch, wird er mit `force: true` überschrieben (`src/lib/github.js:78-79`). Das Gate liest nur `seo/last-pr.json`, das nur der Weg über neue Seiten schreibt (`run.js:232`). PRs aus `improve` erreichen das Gate nie.
4. **Stille Läufe und Fehler.** Benachrichtigt wird nur, wenn ein PR mit `.md`-Dateien existiert (`.github/workflows/seo-reusable.yml:138-155` beenden vorher mit `exit 0`). Index-Status-Fehler werden verschluckt (`:119`). Der Workflow hat keine `concurrency`-Gruppe.

## Goal
- Jeder Lauf schreibt seinen Maschinenstand nach `main`, auch ohne PR.
- SerpAPI- und Anthropic-Ausgaben sind pro Projekt und Monat begrenzt und werden vor jedem bezahlten Aufruf geprüft.
- Jedes Keyword (mit allen Sprachen und Counterpart) und jeder Rewrite ist ein eigener PR. Das Gate verarbeitet alle PRs eines Laufs.
- Der Status eines Keywords auf `main` folgt dem echten PR-Zustand (offen, gemergt, geschlossen).
- Jeder Lauf meldet sich am Ende mit einem Bericht, auch ohne Aktion und auch bei Fehler.

## Non-Goals
- Änderungsbuch, Messung, Kontrollgruppe (Etappe A.2).
- Orchestrator, Phasen, Wochenbericht (Etappe A2).
- Änderung der Seiteninhalte oder Prompts.

## Out of Scope (Files)
- `src/prompts/*`: inhaltlich unverändert.
- `src/lib/dashboard.js`: liest weiter die committeten Dateien auf `main`.
- `src/steps/improve.js`: enthält nur Auswahl und Rewrite, keinen Commit-Code.
- `n8n/` und alle Projekt-Repos (`apps/events`, `apps/zeit/app`, `web/rafaelalex.de`).

## Solution

### Approach
**Stand direkt auf `main`.** Das Dashboard liest aus dem `main`-Checkout, und `index-status --commit` schreibt schon heute nach `main` mit `[skip ci]` (`src/commands/index-status.js:43-54`). PRs enthalten **keine Statusdateien mehr**, nur Seiten. Statusdateien gehen ausschließlich über `commitState`.

Statusdateien: `seo/keywords.json`, `seo/sitemap-pending.json`, `seo/improvements.json`, `seo/index-status.json`, neu `seo/budget.json`. `seo/last-pr.json` entfällt.

**Ablauf eines Laufs nach Teil 2:**
1. Abgleich: Für jedes Keyword mit Status `pr_opened` und gespeicherter `pr_url` den PR per API lesen. Gemergt → `published` und Slug in `sitemap-pending.json`. Geschlossen ohne Merge → `rejected`. Offen → bleibt. Gleiches für `improvements.json`-Einträge (Cooldown bleibt nur bei gemergtem PR bestehen, geschlossener PR entfernt den Eintrag).
2. Discover, Generate, Validate, Fact-Check wie heute. `improve` liefert ein vorbereitetes Ergebnis statt selbst einen PR zu öffnen.
3. `commitState` (Status `pr_opened` für alles, was gleich einen PR bekommt).
4. PRs öffnen, je Keyword ein PR mit allen Sprachdateien und Counterpart. Schlägt ein PR fehl, Status zurück auf `proposed`, Cooldown nicht setzen.
5. `commitState` erneut, falls Schritt 4 etwas geändert hat.
6. Bericht schreiben.

### Teil 1: Infrastruktur

0. Preise und SerpAPI-Account-Endpunkt prüfen: aktuelle Anthropic-Preise pro Million Tokens (Input, Output, Cache-Write, Cache-Read, Batch-Rabatt) für die IDs in `src/lib/models.js`, plus Preis pro `web_search`-Anfrage, aus https://docs.anthropic.com (Pricing). SerpAPI `https://serpapi.com/account.json` (Felder für Monatsverbrauch und verbleibende Suchen, kostet keine Suche). → verify: Werte mit Quelle in der Appendix dieses Plans

1. `src/lib/github.js`: `createBranchAndCommit` ohne `force`. Bei existierendem Branch wirft es einen Fehler mit `code: 'BRANCH_EXISTS'`. Neue Funktion `commitToBranch({ files, message, repo, branch })`: liest den Kopf, baut den Baum auf dem Kopf, committet, aktualisiert den Ref **ohne** `force`. Bei 422 (kein Fast-Forward) neu lesen und bis zu 3× wiederholen, danach Fehler. Den bestehenden Test, der das Force-Update festschreibt (`test/github.test.js:46-49`), entsprechend umschreiben. → verify: `npx vitest run test/github.test.js`, Tests für Retry nach 422, Abbruch nach 3 Versuchen, `BRANCH_EXISTS`

2. Neues `src/lib/state.js`: `STATE_FILES` und `commitState({ cwd, repo, reason })`. Vergleich gegen den Remote-Stand: Baum von `main` lesen und den Git-Blob-SHA des lokalen Inhalts mit dem SHA im Baum vergleichen. Nur abweichende Dateien committen, ohne Abweichung kein Commit. Nachricht `seo: state (<reason>) [skip ci]`. `index-status --commit` (`src/commands/index-status.js:43-54`) nutzt `commitState`. → verify: `npx vitest run test/state.test.js test/index-status.test.js`, Tests für "nichts geändert → kein Commit", "nur geänderte Dateien", Blob-SHA-Berechnung

3. Neues `src/lib/budget.js`: Pfad `seo/budget.json` relativ zu `process.cwd()` (wie `getSerp` und `complete()`, die kein `cwd` kennen). Inhalt `{ month, serpapi: { used }, anthropic: { usd, calls } }`, Monatswechsel setzt zurück. Grenzen aus `seo.config.yaml` `budget: { usd_per_month: 30, serpapi_per_month: 60 }` (Defaults in `src/lib/config.js` DEFAULTS). `assertBudget(kind)` wirft `BudgetExceededError`. Fehlende Datei wird angelegt, unlesbare Datei wirft. → verify: `npx vitest run test/budget.test.js`, Tests für Monatswechsel, Grenze erreicht, unlesbare Datei

4. `src/lib/serpapi.js`: Zählung über `budget.js`. `bumpQuota`/`rollbackQuota` bleiben als Reservierung. Einmal pro Prozess vor der ersten Suche `account.json` lesen. Sind dort 0 Suchen übrig, abbrechen. `MONTHLY_LIMIT` und `SEO_CLI_QUOTA_FILE` entfallen, `checkQuota()` liefert die kleinere der beiden Restmengen. Anpassen: `src/steps/discover.js:65` (Aufrufer von `checkQuota`), `test/discover.test.js:9,16,63` (Mock mit `remaining: 240`), `test/serpapi.test.js:34,54,104` (Quota-Datei und Grenze 240), Erwartungen an die Zahl der `safeFetch`-Aufrufe wegen des zusätzlichen `account.json`-Aufrufs. → verify: `npx vitest run test/serpapi.test.js test/serpapi-getserp.test.js test/discover.test.js`, Tests für Projektgrenze, Account-Grenze, Rückbuchung bei Fehler

5. `src/lib/claude.js` und `src/lib/models.js`: Preistabelle pro Modell in `models.js` (Werte aus Step 0). `complete()` prüft vor jedem API-Aufruf `assertBudget('anthropic')` und bucht danach. Gebucht wird pro API-Antwort, also auch jede `pause_turn`-Fortsetzung (`:164`) und die Batch-Antwort (`:105`, mit Batch-Rabatt). Bepreist wird nach `res.model`, nicht nach angefragtem Modell, weil der Server-Fallback (`claude.js:32`) ein anderes Modell abrechnen kann. Ein unbekanntes Modell wird mit dem teuersten bekannten Preis gebucht und als Warnung geloggt, es wirft nicht. `web_search`-Anfragen werden aus `usage.server_tool_use.web_search_requests` mit dem Preis pro Anfrage gebucht. Rückgabewert von `complete()` bleibt unverändert. → verify: `npx vitest run test/claude.test.js`, Tests für Buchung interaktiv, `pause_turn`, Batch, Websuche, unbekanntes Modell, Abbruch vor dem Aufruf bei erreichter Grenze

### Teil 2: Ablauf

6. `src/commands/improve.js` aufteilen: `prepareImprove({ config, dryRun }, cwd)` macht Auswahl, Rewrite, Validierung und Fact-Check und gibt `{ slug, files, record, prTitle, prBody }` oder `null` zurück, ohne Commit und ohne Cooldown-Eintrag. `publishImprove(prepared, ...)` öffnet den PR auf `seo/improve/<slug>` und setzt den Cooldown-Eintrag mit `pr_url` erst nach Erfolg. Der eigenständige Befehl `seo improve` (`bin/seo.js:45`) führt aus: `prepareImprove` → `commitState` → `publishImprove` → `commitState`. → verify: `npx vitest run test/improve-cmd.test.js`, Tests für "kein Cooldown bei `BRANCH_EXISTS`" und "Cooldown mit `pr_url` nach Erfolg"

7. `src/steps/pr.js`: ein PR pro Keyword auf `seo/new/<slug der Standardsprache>`, mit allen Sprachdateien und Counterpart dieses Keywords. `injectHreflang` (`pr.js:58` ff.) läuft weiter über alle Seiten des Laufs, bevor sie nach Keyword gruppiert werden. Keine Statusdateien im PR. Keyword-Eintrag speichert `pr_url`. `BRANCH_EXISTS` → Keyword überspringen, Status `proposed`, Warnung. `saveLastPR` und `LAST_PR_FILE` entfernen (`src/lib/keywords.js:7,56-60`, `test/keywords.test.js:7-8,75-77`). → verify: `npx vitest run test/pr.test.js test/keywords.test.js`

8. `src/commands/run.js`: Ablauf wie im Approach (Abgleich, Pipeline, `commitState`, PRs, `commitState`, Bericht), mit `try/finally`, damit `commitState` und Bericht auch nach Fehlern laufen. Option `--report <pfad>` (`bin/seo.js`) schreibt `{ status: 'idle'|'prs_opened'|'failed'|'budget_exceeded', prs: [{ url, kind: 'new'|'improve', slug }], budget: {...}, warnings: [string], errors: [string] }`. `BudgetExceededError` beendet den Lauf mit Status `budget_exceeded` und Exit-Code 0. `--dry-run`: kein Abgleich per API, kein `commitState`, keine PRs, Bericht trotzdem. → verify: `npx vitest run test/run-pipeline.test.js test/run.test.js`, Tests für Abgleich (gemergt, geschlossen, offen), Bericht bei idle, PRs, Budget, Fehler, und dass `commitState` im Fehlerfall läuft

9. `.github/workflows/seo-reusable.yml`:
   - `concurrency: { group: seo-${{ github.repository }}, cancel-in-progress: false }` auf dem Job.
   - `SEO_NOTIFY_WEBHOOK` bleibt optional (die Aufrufer und das README-Beispiel `README.md:95-98` übergeben es nicht alle). Fehlt es, schreibt der Lauf eine sichtbare `::warning::`.
   - Run-Schritt: `seo run --report "$RUNNER_TEMP/seo-report.json"`.
   - Index-Status-Schritt: Exit-Code abfangen und bei Fehler eine Zeile in `$RUNNER_TEMP/seo-warnings.txt` schreiben, statt `|| echo`.
   - Gate: Die heutige Logik pro PR (`:138-295`) wird eine Bash-Funktion `gate_pr <url>`, die mit `return` statt `exit` endet, nach `gh pr checkout` mit `git checkout main` zurückkehrt und ihren Status als Zeile `<url> <status>` an `$RUNNER_TEMP/gate-status.txt` anhängt. Die Merge-Logik selbst (`:183-295`) bleibt inhaltlich gleich. Das Gate ruft die Funktion für jede URL aus dem Bericht auf.
   - Letzter Schritt `if: always()`: sendet `{ repo, run_url, status, prs: [{ url, gate_status }], budget, warnings }` an den Webhook, falls gesetzt. `status` ist `failed`, wenn ein vorheriger Schritt fehlschlug, sonst aus dem Bericht.
   → verify: `actionlint .github/workflows/seo-reusable.yml` ohne Befund, `grep -n "last-pr" .github/workflows/seo-reusable.yml` leer

10. README und CLAUDE.md: Statusdateien-Tabelle (Weg "Status-Commit nach main", `budget.json`, `last-pr.json` entfernt), `budget`-Config, PR pro Keyword, Keyword-Status `published`/`rejected`, Bericht und Webhook-Payload, SerpAPI-Abschnitt. Hinweis: Ein lokaler `seo run` ohne `--dry-run` committet jetzt ebenfalls Stand nach `main`, danach `git pull`. `FEATURE_AUDIT.md`: eine Zeile pro neuer Funktion mit Test-ID im `describe`-Namen (Konvention der Datei). → verify: `grep -n "last-pr\|seo-cli-serpapi\|MONTHLY_LIMIT" README.md CLAUDE.md` leer

### Affected Files
- Teil 1: `src/lib/github.js` (37-84), `src/lib/state.js` (neu), `src/lib/budget.js` (neu), `src/lib/serpapi.js`, `src/lib/claude.js` (32, 105, 116-170), `src/lib/models.js`, `src/lib/config.js` (DEFAULTS), `src/commands/index-status.js` (43-54), `src/steps/discover.js` (65); Tests `test/github.test.js`, `test/state.test.js` (neu), `test/budget.test.js` (neu), `test/serpapi.test.js`, `test/serpapi-getserp.test.js`, `test/discover.test.js`, `test/claude.test.js`, `test/index-status.test.js`
- Teil 2: `src/commands/improve.js` (93-124), `src/steps/pr.js`, `src/commands/run.js`, `src/lib/keywords.js` (7, 56-60), `bin/seo.js`, `.github/workflows/seo-reusable.yml`, `README.md`, `CLAUDE.md`, `FEATURE_AUDIT.md`; Tests `test/improve-cmd.test.js`, `test/pr.test.js`, `test/keywords.test.js`, `test/run-pipeline.test.js`, `test/run.test.js`

### Conventions
- ESM, vitest, Mocks nur an Octokit (`test/github.test.js:7-11`), Anthropic SDK (`test/claude.test.js:9`) und `safe-fetch` (`test/serpapi.test.js:10`).
- Statusdateien mit `JSON.stringify(x, null, 2) + '\n'` wie heute.
- Keine Secrets im Code.

## Edge Cases
- Zwei Läufe gleichzeitig: verhindert durch `concurrency`. Menschlicher Push auf `main` dazwischen: `commitToBranch` lädt neu und wiederholt.
- `BRANCH_EXISTS` bei offenem PR zum selben Keyword: überspringen, Warnung im Bericht.
- PR wird abgelehnt (geschlossen): nächster Lauf setzt `rejected`, das Keyword wird nicht erneut vorgeschlagen.
- Budget während eines Batch-Aufrufs überschritten: Aufruf läuft zu Ende, wird gebucht, der nächste wird abgelehnt.
- Erster Lauf eines Projekts oder `seo init`: `budget.json` fehlt und wird angelegt.
- `--dry-run`: kein Abgleich per API, kein Status-Commit, keine PRs, Bericht trotzdem.

## Known Costs
- Mehr PRs pro Woche (einer pro Keyword statt einer pro Lauf). Dafür ist jede Änderung einzeln messbar und zurücknehmbar.
- Abweichung vom ursprünglichen Architekturplan (main statt `seo-state`), dort bereits angepasst.

## Done Criteria
Teil 1:
- [ ] `npx vitest run test/github.test.js test/state.test.js test/budget.test.js test/serpapi.test.js test/serpapi-getserp.test.js test/discover.test.js test/claude.test.js test/index-status.test.js` → exit 0
- [ ] `grep -n "force: true" src/lib/github.js` → keine Treffer
- [ ] `grep -rn "seo-cli-serpapi\|MONTHLY_LIMIT\|SEO_CLI_QUOTA_FILE" src test` → keine Treffer

Teil 2:
- [ ] `npx vitest run test/improve-cmd.test.js test/pr.test.js test/keywords.test.js test/run-pipeline.test.js test/run.test.js` → exit 0
- [ ] `actionlint .github/workflows/seo-reusable.yml` → keine Befunde
- [ ] `grep -rn "last-pr\|LAST_PR_FILE\|saveLastPR" src test .github README.md CLAUDE.md` → keine Treffer

Beide:
- [ ] `npm run lint` → exit 0
- [ ] `git status --short -- src test bin .github README.md CLAUDE.md FEATURE_AUDIT.md`: nur Dateien aus Affected Files

## STOP Conditions
- SerpAPI `account.json` existiert nicht oder kostet eine Suche (Step 0).
- Die Gate-Funktion würde die Merge-Logik ab `:183` inhaltlich ändern müssen, nicht nur pro PR wiederholen.
- Ein Projekt-Repo müsste geändert werden.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.
- Der aktuelle Stand weicht von den genannten Zeilen ab.

## Maintenance Notes
- Nach dem Merge (durch den Orchestrator mit Zustimmung des Nutzers, nicht durch den Executor): n8n-Workflow "SEO: Notify (GitHub to Gmail)" so anpassen, dass `status: idle` keine Mail auslöst und `failed` und `budget_exceeded` sofort mailen. Bis Etappe A2 ist das ein Zwischenstand.
- Die ersten echten Läufe beobachten: Anzahl Status-Commits auf `main`, Kosten in `budget.json` gegen das Startbudget von 30 USD.
- Etappe A.2 (Änderungsbuch) baut auf `commitState`, dem Abgleich (Merge-Datum) und dem Bericht auf.

## Challenge Result
- **Übernommen:** Falsche Pfade zu `improve` (Evaluation): `src/commands/improve.js` statt `src/steps/improve.js`.
- **Übernommen:** `improve` öffnet den PR intern, kollidiert mit "Stand vor PR": Aufteilung in `prepareImprove`/`publishImprove`, eigenständiger Befehl gleich geregelt.
- **Übernommen:** Status auf `main` für PRs, die nie gemergt werden: Abgleich am Laufanfang (`published`/`rejected`), `sitemap-pending.json` erst bei Merge, Rücksetzung bei PR-Fehler.
- **Übernommen:** Counterpart und hreflang bei PR pro Seite: PR pro Keyword mit allen Sprachdateien.
- **Übernommen:** Pflicht-Webhook bricht Aufrufer: bleibt optional mit sichtbarer Warnung.
- **Übernommen:** Gate-Schleife: Bash-Funktion mit `return`, Rückkehr auf `main`, Status-Datei.
- **Übernommen:** Fehlende Dateien und Tests (discover, keywords, serpapi-Tests), Blob-SHA-Vergleich für `commitState`, Kostenlücken (`res.model`, `pause_turn`, Websuche, unbekanntes Modell).
- **Übernommen:** Done-Kriterien präzisiert (`force: true` nur in `github.js`, `git status` auf Code-Pfade), Arbeitsverzeichnis in der Executor-Anweisung.
- **Übernommen:** Plan zu groß für einen Executor: zwei Teile.

## Delegate spec

## Task: seo-cli Etappe A.1, Teil 1 (Infrastruktur)
**Goal:** Commits ohne Force mit Retry, `commitState` nach `main`, Budget pro Projekt und Monat für SerpAPI und Anthropic, vor jedem bezahlten Aufruf geprüft. Done Criteria "Teil 1" und "Beide" grün.
**Context:** Repo `/Users/rafael/Developer/apps/seo-cli` @ `860b86d`. Plan: `docs/plans/2026-10-06-etappe-a1-fundament.md`, Abschnitte Problem, Approach, Teil 1. Vorbild für Commit nach main: `src/commands/index-status.js:43-54`. Vorbild für Octokit-Mocks: `test/github.test.js:7-24`.
**Affected files:** Affected Files, Teil 1.
**Out of Scope:** alles aus Teil 2, `src/prompts/*`, `src/lib/dashboard.js`, `src/steps/improve.js`, `n8n/`, Projekt-Repos.
**Steps:** 1 bis 5 (Step 0 ist erledigt, Werte in der Appendix), in dieser Reihenfolge, jeweils mit dem genannten verify.
**Done criteria (all):** Teil 1 und Beide. Nur gefilterte Tests, keine volle Suite.
**STOP conditions:** siehe STOP Conditions.

## Task: seo-cli Etappe A.1, Teil 2 (Ablauf)
**Goal:** Abgleich mit dem PR-Zustand, ein PR pro Keyword und pro Rewrite, Stand vor und nach den PRs nach `main`, Laufbericht, Gate für alle PRs, Webhook am Ende jedes Laufs. Done Criteria "Teil 2" und "Beide" grün.
**Context:** Setzt Teil 1 voraus (`commitToBranch`, `commitState`, `budget.js`, `BRANCH_EXISTS`). Plan wie oben, Abschnitte Approach (Ablauf eines Laufs), Teil 2.
**Affected files:** Affected Files, Teil 2.
**Out of Scope:** Dateien aus Teil 1 außer zum Aufruf, `src/prompts/*`, `src/lib/dashboard.js`, `src/steps/improve.js`, `n8n/`, Projekt-Repos.
**Steps:** 6 bis 10, in dieser Reihenfolge, jeweils mit dem genannten verify.
**Done criteria (all):** Teil 2 und Beide. Nur gefilterte Tests, keine volle Suite.
**STOP conditions:** siehe STOP Conditions.

## Appendix
Step 0 erledigt am 2026-10-06 durch den Orchestrator.

**Anthropic-Preise** (USD pro Million Tokens, Quelle https://platform.claude.com/docs/en/about-claude/pricing, abgerufen 2026-10-06):

| Modell (ID) | Input | Cache-Write 5 min | Cache-Write 1 h | Cache-Read | Output | Batch Input | Batch Output |
|---|---|---|---|---|---|---|---|
| Opus 5.5 (`claude-opus-5-5`) | 4 | 5 | 8 | 0.20 | 20 | 2 | 10 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 2 | 2.50 | 4 | 0.20 | 10 | 1 | 5 |
| Haiku 4.5 (`claude-haiku-4-5-20251001`) | 1 | 1.25 | 2 | 0.10 | 5 | 0.50 | 2.50 |

- Batch: 50 % auf Input und Output. Cache-Multiplikatoren stapeln sich mit dem Batch-Rabatt (Cache-Preise im Batch also ebenfalls halbieren).
- `usage`-Felder: `input_tokens`, `output_tokens`, `cache_creation_input_tokens` (als 5-min-Write bepreisen), `cache_read_input_tokens`, `server_tool_use.web_search_requests`.
- Websuche: 10 USD pro 1.000 Suchen (0.01 USD pro Anfrage), zusätzlich zu den Tokens. Fehlgeschlagene Suchen werden nicht berechnet.
- Teuerstes bekanntes Modell für unbekannte IDs: Opus 5.5.

**SerpAPI Account API** (Quelle https://serpapi.com/account-api, abgerufen 2026-10-06):
- `GET https://serpapi.com/account.json?api_key=<key>`. Kostenlos, zählt nicht zum Monatskontingent.
- Felder: `searches_per_month`, `this_month_usage`, `plan_searches_left`, `total_searches_left`, `extra_credits`, `plan_renewal_date`, `account_rate_limit_per_hour`, `this_hour_searches`.
- Für die Account-Grenze `total_searches_left` verwenden (enthält Zusatz-Credits).
