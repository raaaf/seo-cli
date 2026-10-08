# Diagnose für Index-Alarme

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat 1346db2..HEAD -- src/ test/ .github/` must be empty.

## Meta
- Planned at: commit `1346db2` (seo-cli main), 2026-10-07. Branch `feature/watch-diagnose`, worktree `apps/seo-cli-diagnose`.
- Ersetzt B.2 in der Reihenfolge. B.2 (GSC und Index-Status als Signal-Adapter) ist zurückgestellt: GSC ist kostenlos und ändert sich täglich, Index-Status steht schon in `seo/index-status.json`, doppelte Abrufe zwischen `run` und `watch` gibt es nicht (Nutzerentscheidung 2026-10-07). Unabhängig von PR #83 (B.1); Überschneidung nur in `CLAUDE.md`, `README.md`, `FEATURE_AUDIT.md`.
- Challengers: Architecture und Risk (immer). Product übersprungen (Umfang vom Nutzer entschieden), Design übersprungen (keine UI außer Mailtext), Simplicity übersprungen (Umfang entschieden). Drift check: vom Orchestrator gelaufen, keine Abweichung.
- Status: Spec

## Problem
1. `seo watch` meldet `deindexed` und `site_not_indexed`, sagt aber nicht warum. Bei zeit (0 von 14 indexiert, alle „Crawled - currently not indexed“, technisch sauber) muss die Ursache heute von Hand gesucht werden.
2. `fetchIndexStatus` (`src/lib/index-status.js:42-49`) verwirft `googleCanonical`, `userCanonical`, `pageFetchState`.
3. Nach einer Behebung reicht niemand Sitemap und IndexNow neu ein.

## Goal
- Jeder offene Index-Alarm trägt eine technische Diagnose (`alert.diagnosis`) mit Befund-Codes und Fix-Text, täglich geprüft, ohne LLM, ohne täglichen Commit.
- Ist der Live-Abruf sauber, reicht der Wächter Sitemap (GSC) und IndexNow neu ein, höchstens einmal pro Lauf und alle 7 Tage.
- Ist der Live-Abruf sauber, bewertet der Wochenlauf den Inhalt (`alert.assessment`, bis zu 5 Maßnahmen). Kein automatischer Rewrite (Nutzerentscheidung 2026-10-07: Empfehlung in der Mail, Warteschlange mit Etappe C).
- Die Mail zeigt Diagnose und Bewertung.

## Non-Goals
- Kein freier Agent mit WebFetch: ein begrenzter Aufruf mit schon abgerufenem Text ist billiger und testbar.
- Kein Rewrite, keine Warteschlange (Etappe C). Keine Diagnose für `traffic_drop`, `watch_blind`.
- Keine Google Indexing API (nur JobPosting/BroadcastEvent).

## Out of Scope (Files)
- `src/lib/signals/*`, `src/lib/serpapi.js`: B.1 auf eigenem Branch.
- `src/steps/improve.js`, `src/steps/discover.js`: keine Kopplung an Diagnosen.
- `src/lib/budget.js`: `complete()` bucht schon selbst.
- `evaluateWatch` in `src/lib/watch.js`: Regeln bleiben, die Datei bekommt nur die verschobenen Helfer.

## Solution

### Approach
Zwei Stufen, damit der tägliche Wächter ohne LLM und API-Schlüssel bleibt (`seo-reusable.yml:112` installiert Claude Code im Watch-Modus nicht).

**Abruf:** `fetchForDiagnosis(url, { locale })` in `src/lib/diagnose.js` ruft `safeFetch` mit `signal: AbortSignal.timeout(10000)`, Googlebot-User-Agent und `Accept-Language: <locale>` (Grund: `src/lib/indexnow.js:8-12`) und gibt `{ status, finalUrl, headers, html }` zurück; `html` auf 500 KB gekürzt. `safeFetch` folgt Weiterleitungen manuell, `finalUrl` ist die letzte URL. `fetchPages` passt nicht (verwirft Nicht-OK-Antworten).

**Stufe 1, technisch (`seo watch`, täglich):** reine Funktion `diagnoseUrl({ url, inspection, response, robotsStatus })` → `{ cause, findings: [{ code, source, detail, fix }] }`. `source` ist `live` (eigener Abruf) oder `google` (letzter Crawl laut Inspection, kann veraltet sein). Alle URL-Vergleiche über einen Helfer `sameUrl(a, b, base)`: relative href gegen `base` auflösen, Schema, Host klein, ohne `www.`, ohne abschließenden Slash, ohne Fragment, Query beibehalten.

| Code | source | Bedingung | Wirkung |
|---|---|---|---|
| `not_found` | live | 404, 410 | technical |
| `server_error` | live | ≥ 500 | unknown |
| `blocked_for_bot` | live | 401, 403, 429 | unknown |
| `http_error` | live | sonst ≥ 400 | technical |
| `redirect` | live | nicht `sameUrl(finalUrl, url)` | technical |
| `noindex_header` | live | `X-Robots-Tag` enthält `noindex` (auch `googlebot: noindex`) | technical |
| `noindex_meta` | live | Meta `robots`/`googlebot` mit `noindex` | technical |
| `canonical_other` | live | Canonical nicht `sameUrl` zur URL | technical |
| `robots_unreachable` | live | `robots.txt` ≥ 500 | technical |
| `no_text` | live | unter 50 Wörtern sichtbarer Text bei 200 | Hinweis |
| `google_canonical_other` | google | `googleCanonical` gesetzt, nicht `sameUrl` | Hinweis |
| `robots_blocked` | google | `robotsTxtState === 'DISALLOWED'` | Hinweis |
| `google_fetch_failed` | google | `pageFetchState` gesetzt, nicht `SUCCESSFUL`, nicht `PAGE_FETCH_STATE_UNSPECIFIED`, nicht `SOFT_404` | Hinweis |
| `soft_404` | google | `pageFetchState === 'SOFT_404'` | Hinweis (inhaltlich) |
| `fetch_failed` | live | Abruf wirft (DNS, Timeout) | unknown |

`cause`: `technical`, sobald ein Live-Code mit Wirkung technical zutrifft. Sonst `unknown`, wenn ein Code mit Wirkung unknown zutrifft oder der Inspection-Eintrag fehlt oder `coverageState === 'unknown'` ist. Sonst `clean`. Google-Hinweise entscheiden nie die Ursache: sie können nach einem Fix bis zum nächsten Crawl stehen bleiben, und das Neu-Einreichen soll genau diesen Crawl auslösen. `fix` ist ein fester englischer Satz pro Code (wie die Alarmtexte in `src/lib/watch.js`).

`diagnoseAlerts({ alerts, entries, config, today, fetch = fetchForDiagnosis })` in `src/steps/diagnose.js`: sammelt die URLs aller offenen `deindexed`- (URL = `detail`) und `site_not_indexed`-Alarme (nicht indexierte URLs aus `entries`, `base_url` zuerst, dann Sitemap-Reihenfolge), entdoppelt sie und prüft höchstens 10 pro Lauf, nacheinander; `robots.txt` einmal. Ein Alarm mit mehr URLs als geprüft bekommt `sampled: true`. Pro Alarm: `diagnosis = { checked_at, cause, codes, urls: [{ url, cause, findings }] }`, `codes` sortiert und entdoppelt aus allen Befunden. Ein Ergebnis `unknown` ersetzt eine vorhandene Diagnose nicht (ein wackeliger Abruf löst weder Mail noch Commit aus). Neue oder verschwundene Codes werden erst übernommen, wenn zwei Läufe in Folge dasselbe Ergebnis liefern (`pending_codes` mit Datum am Alarm); ausgenommen ist die erste Diagnose eines Alarms, die sofort gilt. `checked_at` und `urls` werden nur geschrieben, wenn sich `cause` oder `codes` ändern, damit ein ruhiger Tag keinen Commit erzeugt. Die Diagnose wird in das vorhandene Alarmobjekt gemischt (`Object.assign`), nicht ersetzt: `evaluateWatch` teilt die Objekte zwischen `opened` und `next.open` (`src/lib/watch.js:77-79`), und `assessment` sowie `resubmitted_at` müssen erhalten bleiben.

Einbau in `src/steps/watch.js` nach `evaluateWatch`. `diagnoseAlerts` bekommt die `entries` aus `checkIndexStatus` (`src/steps/watch.js:62-66`, kein zweiter Sitemap-Abruf) und läuft nicht, wenn `entries` null ist (Index-Check fehlgeschlagen). Reihenfolge: `saveAlerts` sofort nach `evaluateWatch` (der langsame Teil kann den Stand nicht mehr verlieren), dann Diagnose, dann erneut `saveAlerts`. Diagnosefehler → `warnings`, nie `errors`. `watch()` bekommt die Parameter `diagnose` und `submit` mit den echten Funktionen als Standardwert, damit Tests nicht ins Netz gehen. Ein schon offener Alarm, dessen `cause` oder `codes` sich ändern, kommt in `report.alerts.updated`; Status `alert`, wenn `opened` oder `updated` nicht leer sind.

**Neu einreichen:** Ist mindestens ein Alarm `clean` ohne `resubmitted_at` und liegt `alerts.last_resubmit` mindestens 7 Tage zurück (oder fehlt), ruft der Wächter einmal `submitSitemap` (`src/lib/gsc.js`, Schreib-Scope laut `:12-14`) und mit `config.indexnow_key` einmal `submitIndexNow` mit den sauberen URLs. Danach `resubmitted_at = today` an diesen Alarmen und `last_resubmit = today` auf oberster Ebene. Fehler → Warnung, nichts gesetzt. Dry Run reicht nichts ein.

**Index-Felder:** `fetchIndexStatus` speichert zusätzlich `googleCanonical`, `userCanonical`, `pageFetchState` (im Quota-Zweig `null`). `crawledAs` wird bewusst nicht gespeichert (wechselt zwischen Crawls und brächte tägliche Commits).

**Stufe 2, inhaltlich (`seo run`, wöchentlich):** `loadAlerts`/`saveAlerts` wandern von `src/steps/watch.js:12-30` nach `src/lib/watch.js` (exportiert, unverändert). `assessAlerts({ config, cwd, dryRun, warnings })` in `src/steps/assess.js`, aufgerufen in `src/commands/run.js` direkt nach `measure` (`:404`), Fehler → Warnung, `BudgetExceededError` wird weitergeworfen (`run.js:493`). Kandidaten: offene Alarme mit `diagnosis.cause === 'clean'` ohne `assessment` oder mit `assessed_at` älter als 28 Tage; `site_not_indexed` zuerst, höchstens 3 Aufrufe pro Lauf. Pro Alarm ein `complete()` (`MODELS.default`, JSON-Schema, kein Web Search), Prompt `src/prompts/assess.md`. Eingaben: Alarmart, Inspection-Felder und Hinweis-Codes der URLs, Seitentext der ersten URL (`fetchForDiagnosis`, dann `stripHtml` aus `src/lib/site-fetch.js:6` in `assess.js`, 4000 Wörter) im `<<<UNTRUSTED_PAGE_START>>>`-Block über `fillTemplate`, Zahl der Sitemap-URLs, Anteil indexierter URLs. Schema: `likely_causes` (max 3, je maxLength 200), `actions` (max 5, `action` maxLength 200, `why` maxLength 300). Vor dem Speichern werden HTML-Tags und URLs aus allen Strings entfernt. Gespeichert als `alert.assessment = { assessed_at, likely_causes, actions }`; `report.assessments` listet die neuen mit `alert_id`. Dry Run: Aufruf und Ausgabe, nichts speichern. `alerts.json` steht schon in `STATE_FILES` (`src/lib/state.js:14`).

**Konsole:** `src/commands/watch.js:30-33` gibt zusätzlich `updated` (Codes) und ein erfolgtes Neu-Einreichen aus.

**Mail:** `updated` erreicht n8n schon, weil `seo-reusable.yml:385` `.alerts` ganz weitergibt. `.github/workflows/seo-reusable.yml:403-410` gibt zusätzlich `assessments: ($report.assessments // [])` weiter. n8n „SEO: Notify (GitHub to Gmail)“ (`5YM2niVBSDPtbADs`) zeigt pro Alarm in `opened`/`updated` die Codes mit `fix`, `resubmitted_at` und die Bewertungen, alle Texte HTML-escaped, und überspringt einen Lauf nicht, wenn `assessments` nicht leer ist. n8n macht der Orchestrator per MCP.

### Steps
1. `src/lib/diagnose.js`: `sameUrl`, `fetchForDiagnosis`, `diagnoseUrl`. → verify: `npx vitest run test/diagnose.test.js` (ein Test pro Code und pro `cause`-Zweig inkl. fehlendem Inspection-Eintrag; `sameUrl` mit relativer href, `www.`, Slash; Google-Hinweis allein ergibt `clean`)
2. Index-Felder. → verify: `npx vitest run test/index-status.test.js`
3. Helfer nach `src/lib/watch.js`, `diagnoseAlerts`, Einbau in `watch`, `updated`, Neu-Einreichen. → verify: `npx vitest run test/diagnose-step.test.js test/watch-step.test.js test/watch.test.js` (Diagnose am Alarm, `assessment` bleibt erhalten; gleiche Codes am Folgetag → `alerts.json` unverändert; `unknown` behält alte Diagnose; Codes geändert erst am zweiten gleichen Lauf → `updated`; erste Diagnose sofort; `entries` null → keine Diagnose; Entdoppelung und Cap 10; ein Einreichen pro Lauf, keins innerhalb 7 Tagen; Einreich-Fehler setzt nichts; Diagnosefehler → Warnung, Status nicht `failed`; Dry Run reicht nicht ein). Bestehende Mocks in `test/watch-step.test.js` nur ergänzen.
4. `assess.js`, Prompt, Aufruf in `run`, Workflow-jq. → verify: `npx vitest run test/assess.test.js test/run.test.js test/run-pipeline.test.js` (nur `clean`; 28-Tage-Frist; `site_not_indexed` zuerst, Cap 3; Dry Run speichert nicht; Fehler → Warnung; `BudgetExceededError` wird weitergeworfen; Markup und URLs entfernt) und `grep -n 'assessments' .github/workflows/seo-reusable.yml` → ein Treffer im Notify-jq
5. Doku: `CLAUDE.md` (watch-Abschnitt, assess, Prompt-Liste, `alerts.json`-Zeile), `README.md`, `FEATURE_AUDIT.md`. → verify: `grep -n "diagnos\|assess" CLAUDE.md README.md`
6. (Orchestrator) n8n-Notify anpassen, nach Merge `workflow_dispatch` mode=watch auf zeit. → verify: Mail zeigt Befunde, `alerts.json` auf zeit main hat `diagnosis` mit `cause: clean` und `resubmitted_at`.

### Affected Files
- neu: `src/lib/diagnose.js`, `src/steps/diagnose.js`, `src/steps/assess.js`, `src/prompts/assess.md`, `test/diagnose.test.js`, `test/diagnose-step.test.js`, `test/assess.test.js`
- geändert: `src/lib/index-status.js`, `src/lib/watch.js` (nur Helfer), `src/steps/watch.js`, `src/commands/watch.js` (nur Ausgabe), `src/commands/run.js`, `.github/workflows/seo-reusable.yml` (nur Notify-jq), `test/index-status.test.js`, `test/watch-step.test.js`, `test/run.test.js`/`test/run-pipeline.test.js` (nur Mocks, falls nötig), `CLAUDE.md`, `README.md`, `FEATURE_AUDIT.md`

### Conventions
- Untrusted-Daten nur in `<<<UNTRUSTED_*>>>`-Blöcken über `fillTemplate`/`sanitizeUntrusted` (`src/lib/template.js`). Vorlage: `src/prompts/review.md` mit `src/steps/review.js`.
- Externe Abrufe nur über `safeFetch`. Tests mocken nur I/O (`gsc.js`, `indexnow.js`, `claude.js`, injizierte `fetch`/`diagnose`/`submit`), Muster wie `test/watch-step.test.js`.
- Alarm- und Fix-Texte englisch.

## Edge Cases
- Ganze Seite fällt aus dem Index (2026-08-04): viele `deindexed`-Alarme, Cap 10 Abrufe, ein Einreichen, höchstens 3 Bewertungen pro Woche.
- Alarm schließt: Diagnose und Bewertung verschwinden mit ihm; `last_resubmit` bleibt und bremst ein Wiederöffnen.
- `alerts.json` von vor diesem Plan: Alarme ohne `diagnosis` bekommen sie beim nächsten Watch (ein Commit).
- Firewall blockt den Googlebot-Abruf: `blocked_for_bot`, `unknown`, kein Einreichen, keine Bewertung.
- Wochenlauf ohne Claude-Zugang: Warnung, keine Bewertung.

## Known Costs
- Bis zu 11 HTTP-Abrufe pro Watch und Projekt mit offenem Index-Alarm, täglich.
- Bis zu 3 Sonnet-Aufrufe pro Projekt und Woche, in der Regel einer alle 28 Tage.

## Done Criteria
- [ ] `npx vitest run test/diagnose.test.js test/diagnose-step.test.js test/assess.test.js test/index-status.test.js test/watch-step.test.js test/watch.test.js test/run.test.js test/run-pipeline.test.js` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `git status`: nur Affected Files

## STOP Conditions
- Ein bestehender Test müsste inhaltlich geändert werden (Ergänzen von Mocks ist erlaubt).
- `evaluateWatch` müsste sich ändern.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Maintenance Notes
- Etappe C übernimmt `assessment.actions` in die Warteschlange.
- B.2 neu bewerten, wenn eine zweite Quelle Index-Daten liefert (Bing).

## Challenge Result
Konsolidierung: 16 Punkte → 11 nach Entdoppelung. Konvergent (Architecture + Risk): täglicher Commit, Mail ohne Bewertung, falsche technische Befunde, Kosten bei Massen-Deindexierung.
- **Übernommen:** Täglicher Commit durch `checked_at` und wechselnde Index-Felder (beide): `checked_at` nur bei Änderung, `crawledAs` nicht gespeichert.
- **Übernommen:** Notify-jq verwirft `assessments` (beide): Workflow in Affected Files, jq ergänzt, n8n überspringt nicht.
- **Übernommen:** Fehlbefunde durch Firewall, 5xx, JS-Seiten, Canonical-Vergleich, fehlendes Accept-Language (beide): `blocked_for_bot`/`server_error` → unknown, `no_text` Hinweis, `sameUrl`, Locale-Header.
- **Übernommen:** Kosten und Kaskade bei vielen Alarmen (beide): Entdoppelung, Cap 10, ein Einreichen pro Lauf, Bewertung Cap 3.
- **Übernommen:** Veraltete Google-Daten blockieren das Einreichen (Risk): Google-Befunde nur Hinweise, `cause` aus Live-Abruf.
- **Übernommen:** Kein Timeout (Risk): `AbortSignal.timeout`, Speichern vor der Diagnose.
- **Übernommen:** Tests würden ins Netz gehen, `fetchImpl` nicht möglich (Architecture): injizierbare `diagnose`/`submit`, eigener Abruf-Wrapper.
- **Übernommen:** Alarm-Wackeln und Objekt-Teilen (Architecture): `unknown` behält alte Diagnose, Mischen statt Ersetzen.
- **Übernommen:** Fehlender oder `unknown` Inspection-Eintrag als `clean` (Architecture): ergibt `unknown`.
- **Übernommen:** LLM-Text in die Mail (Risk): maxLength, Markup und URLs entfernen, n8n escaped.
- **Übernommen:** `BudgetExceededError` verschluckt (Risk), Einreichen bei wiederkehrendem Alarm (Risk): weiterwerfen, `last_resubmit` mit 7 Tagen.

- **Übernommen (Evaluation):** `src/commands/watch.js` gibt `updated` und Einreichen aus; `entries` aus `checkIndexStatus`, keine Diagnose bei null; `stripHtml` in `assess.js`; jq-Verify; Codes erst nach zwei gleichen Läufen.
- **Abgelehnt (Evaluation):** Race zwischen `seo run` und Watch-Commit auf `alerts.json`: die Concurrency-Group `seo-${{ github.repository }}` (`seo-reusable.yml:47`) serialisiert alle Jobs, der Job checkt main frisch aus, und im Run-Modus liest der Watch-Schritt die lokale Datei mit der Bewertung.
- **Offener Punkt (bewusst):** Ein sauberer, neu eingereichter Alarm, der nicht indexiert wird, eskaliert nicht weiter; die Bewertung alle 28 Tage ist die Reaktion, mehr gehört in Etappe C.

## Delegate spec

## Task: Diagnose für Index-Alarme
**Goal:** Offene `deindexed`/`site_not_indexed`-Alarme tragen eine technische Diagnose ohne täglichen Commit, ein sauberer Alarm reicht höchstens einmal pro 7 Tage Sitemap und IndexNow neu ein, der Wochenlauf ergänzt eine inhaltliche Bewertung; alle Done Criteria grün.
**Context:** Abschnitt Solution dieses Plans (Codes-Tabelle, `cause`-Regel, Signaturen, Aufrufstellen `src/steps/watch.js` nach `evaluateWatch`, `src/commands/run.js:404`, `.github/workflows/seo-reusable.yml:403-410`).
**Affected files:** Abschnitt Affected Files.
**Out of Scope:** `evaluateWatch` in `src/lib/watch.js`, `src/lib/signals/*`, `src/lib/serpapi.js`, `src/lib/budget.js`, `src/steps/improve.js`, `src/steps/discover.js`, n8n.
**Steps:** 1 bis 5 aus Steps, je mit ihrem verify. Schritt 6 macht der Orchestrator.
**Done criteria (all):** Abschnitt Done Criteria.
**STOP conditions:** Abschnitt STOP Conditions.
