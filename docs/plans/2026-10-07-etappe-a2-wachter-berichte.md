# Etappe A2: Wächter, Laufbericht als Stand, Wochenbericht

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat ead7c76..HEAD -- src/ test/ .github/ bin/`

## Meta
- Planned 2026-10-07 on seo-cli main `ead7c76`.
- Teil von `docs/plans/2026-10-06-system-architecture.md`, Etappe A2 ("Orchestrator und Berichte"), bewusst schlanker geschnitten: Zeitplan und Wochenbericht bleiben in n8n, das bereits ein GitHub-Credential für alle drei Repos hat. Ein eigener Orchestrator-Workflow in seo-cli bräuchte einen neuen Token mit Schreibrechten auf alle Repos, das verschiebt sich auf den Punkt, an dem Phasen pro Projekt nötig werden (punktundpause.de).
- Status: Spec

## Problem
1. Abstürze und Deindexierung fallen nur im Wochenlauf auf. zeit war 2026-08-04 fünf Wochen unbemerkt deindexiert.
2. Der Laufbericht liegt nur im Runner (`$RUNNER_TEMP/seo-report.json`, `src/lib/report.js`), es gibt keinen Verlauf und keine Grundlage für einen Bericht über alle Projekte.
3. Der Workflow kennt nur volle Läufe (`.github/workflows/seo-reusable.yml:143-150`), einen Lauf ohne LLM gibt es nicht.

## Goal
- Täglicher Wächter pro Projekt ohne LLM: Index-Status plus Traffic-Einbruch. Meldung nur bei neuem oder behobenem Problem, keine Wiederholung.
- Jeder Lauf (voll oder Wächter) hinterlässt `seo/last-run.json` und `seo/runs.jsonl` (letzte 26 Einträge) im Projekt.
- Montags ein Wochenbericht über alle Projekte per Mail.

## Solution

### Approach
**Workflow-Eingabe `mode`** (`run` Standard, `watch`). Bei `watch` laufen nur Checkout, Credentials, `seo watch --report`, Index-Status und Notify. "Run seo", Claude-Code-Installation und Gate werden übersprungen.

**`seo watch`** (neuer Befehl `src/commands/watch.js`, Logik in `src/steps/watch.js`):
- Index: `checkIndexStatus` wie heute (`src/steps/index-check.js`); `diff.newlyDropped` nicht leer → Alarm `deindexed` mit den URLs.
- Traffic: GSC-Summen aller Landingpages (über `queryPageTotals` und die Slug-Zuordnung aus `src/lib/measure.js`) für die letzten 7 Tage (Ende heute-3) gegen dieselben Wochentage davor. Impressionen gefallen um mehr als 40 % bei mindestens 200 Impressionen im Vergleichsfenster → Alarm `traffic_drop`.
- Alarme stehen in `seo/alerts.json` (`{ open: [{ id, kind, since, detail }] }`). Gemeldet wird nur, was neu dazukommt (`status: alert`) oder verschwindet (`status: resolved`). Bleibt alles gleich, `status: watch_ok`.
- Kein LLM, kein SerpAPI, keine Budget-Buchung.

**Laufbericht als Stand:** `seo run` und `seo watch` schreiben vor dem letzten `commitState` `seo/last-run.json` (der Bericht ohne `changed`-Listen) und hängen eine Zeile an `seo/runs.jsonl` (`{ date, mode, status, prs, llm, budget, warnings: n, errors: n }`, gekürzt auf 26 Zeilen). Beide Dateien und `seo/alerts.json` kommen in `STATE_FILES`.

**Notify:** Payload bekommt `mode` und bei `watch` `alerts: { opened, resolved }`. Die n8n-Weiche mailt bei `watch_ok` nicht.

**Zeitplan in n8n** (nach dem Merge, durch den Orchestrator):
- "SEO: Trigger GitHub Workflows": täglich 07:00 Europe/Berlin `mode=watch` für alle drei Repos; donnerstags 13:00 wie heute `mode=run`, 30 Minuten Abstand.
- Neu "SEO: Weekly Digest": montags 08:00, liest per GitHub-API `seo/runs.jsonl`, `seo/budget.json`, `seo/alerts.json`, `seo/changes.json` aus allen drei Repos und schickt eine Mail: pro Projekt Läufe der Woche, PRs, Messungen (Zählungen), offene Alarme, Kosten.

**Projekt-Workflows** (`.github/workflows/seo.yml` in den drei Repos): `workflow_dispatch`-Eingabe `mode` (Standard `run`) und Weitergabe `with: mode: ${{ inputs.mode }}`; Pin auf den neuen seo-cli-Commit.

### Verbindliche Ergänzungen aus der Challenge (gehen dem Text oben vor)
1. **Deindex-Alarm aus dem aktuellen Zustand, nicht aus dem Tagesdiff.** `alerts.json` führt `known_indexed: [url]` (URLs, die je als indexiert gesehen wurden). Offener Alarm `deindexed` = URLs aus `known_indexed`, die jetzt nicht indexiert sind. Behoben erst, wenn sie wieder indexiert sind. Der bisherige Schritt "Check index status" im Run-Modus wird durch `seo watch --commit` ersetzt, damit auch der Donnerstagslauf über dieselbe Logik geht.
2. **Keine täglichen Commits ohne Änderung.** `seo watch --commit` committet nur seine eigenen Dateien (`seo/alerts.json`, `seo/index-status.json`) und nur, wenn sie sich inhaltlich geändert haben. `commitState` bekommt dafür einen optionalen Parameter `files`. `saveIndexStatus` lässt `updated` unverändert, wenn die Einträge gleich sind. `last-run.json` und `runs.jsonl` schreibt nur der Run-Modus (`seo run`, `seo improve`), nicht der Wächter.
3. **Wächter darf nicht blind werden.** Ein Eintrag mit `coverageState: 'unknown'` (Kontingent) überschreibt nie den vorherigen Eintrag. GSC- oder Inspektionsfehler zählen in `alerts.json` als `failures`; nach 2 Fehlläufen in Folge Alarm `watch_blind`, behoben beim ersten erfolgreichen Lauf.
4. **Schritte im Workflow:** Im Watch-Modus laufen checkout, setup-node, seo-cli checkout, `npm ci`, Google-Credentials, `seo watch --commit --report`, Notify, Cleanup. Mit `if: inputs.mode != 'watch'` übersprungen: 1Password- und Direkt-Secrets, Claude-Code-Installation, "Run seo", Gate. `seo watch` braucht weder `ANTHROPIC_API_KEY` noch `SERPAPI_KEY`. Hinweis für die README: Der seo-cli-Checkout hat keinen `ref`, der Pin im Projekt fixiert nur die Workflow-Datei, der Code ist immer `main`.
5. **Reihenfolge:** `concurrency` pro Repo bleibt. Wächter 07:00, Wochenlauf 13:00, die Läufe überschneiden sich praktisch nicht.
6. **Traffic-Alarm mit Hysterese:** Alarm erst nach 2 aufeinanderfolgenden Tagen mit mehr als 40 % weniger Impressionen bei mindestens 200 im Vergleichsfenster (`pending` in `alerts.json`), behoben erst, wenn der Rückgang unter 25 % liegt. `queryPageTotals` mit `pageFilter: config.base_url`.
7. **Notify:** `curl --fail`, bei Fehler eine Warnung im Log. Verpasste Alarm-Mails holt der Wochenbericht nach, er listet alle offenen Alarme.
8. **Laufbericht:** `runs.jsonl` auf 52 Zeilen. `seo improve` schreibt den Laufbericht ebenfalls. Der n8n-Wochenbericht behandelt fehlende Dateien (404) als leer.

### Steps
1. `src/lib/github.js`: nichts Neues nötig. `src/lib/state.js`: `STATE_FILES` um `seo/last-run.json`, `seo/runs.jsonl`, `seo/alerts.json`. → verify: `npx vitest run test/state.test.js`
2. `src/lib/runlog.js`: `writeRunLog({ cwd, report, mode })` schreibt `last-run.json` und hängt an `runs.jsonl` an (26 Zeilen). Aufruf in `src/commands/run.js` im `finally` vor dem zweiten `commitState`. → verify: `npx vitest run test/runlog.test.js test/run-pipeline.test.js` (Kürzung auf 26, Aufruf auch bei Fehler, nicht bei `--dry-run`)
3. `src/steps/watch.js` und `src/commands/watch.js`, Registrierung in `bin/seo.js` mit `--report`, `--commit`, `--dry-run`. Traffic-Fenster und Schwellen als reine Funktionen in `src/lib/watch.js`. → verify: `npx vitest run test/watch.test.js test/watch-step.test.js`: neuer Deindex-Alarm; gleicher Alarm am Folgetag wird nicht erneut gemeldet; behoben → `resolved`; Einbruch über 40 % mit Volumen → Alarm; unter Volumen → kein Alarm; GSC-Fehler → Warnung, kein Alarm, nichts gespeichert; `runlog` mit `mode: watch`.
4. `.github/workflows/seo-reusable.yml`: Eingabe `mode`, Bedingungen für die Schritte, Watch-Schritt, Payload mit `mode` und `alerts`. Den Index-Schritt im Watch-Modus nicht doppelt laufen lassen (`seo watch` macht ihn). → verify: `actionlint .github/workflows/seo-reusable.yml`
5. README und CLAUDE.md: Wächter, Alarme, Laufbericht-Dateien, `mode`. `FEATURE_AUDIT.md` mit Test-IDs. → verify: `grep -n "seo watch" README.md CLAUDE.md`

### Affected Files
- neu: `src/lib/runlog.js`, `src/lib/watch.js`, `src/steps/watch.js`, `src/commands/watch.js`, `test/runlog.test.js`, `test/watch.test.js`, `test/watch-step.test.js`
- geändert: `src/lib/state.js` (`commitState` mit optionalem `files`), `src/lib/index-status.js` (`updated` stabil, `unknown` behält alten Eintrag), `src/commands/improve.js` (Laufbericht), `src/commands/run.js` (`finally`), `bin/seo.js`, `.github/workflows/seo-reusable.yml`, `test/state.test.js`, `test/run-pipeline.test.js`, `README.md`, `CLAUDE.md`, `FEATURE_AUDIT.md`

### Conventions
- GSC-Mock an der Modulgrenze wie `test/measure-step.test.js`, Index-Status gemockt wie `test/index-status.test.js`.
- Reine Funktionen in `src/lib/watch.js`, I/O in `src/steps/watch.js`.

## Edge Cases
- Projekt ohne Daten in GSC (zeit heute): Traffic-Prüfung `insufficient`, kein Alarm; Index-Alarm funktioniert trotzdem.
- Wächter und Wochenlauf am selben Tag: `concurrency` pro Repo sorgt für Reihenfolge.
- `runs.jsonl` fehlt oder ist kaputt: neu anlegen, Warnung.

## Known Costs
- Täglich ein Workflow-Lauf pro Repo (ein paar Minuten Actions-Zeit, Index-Prüfung bis zu 1 s pro URL).
- Zeitplan und Wochenbericht hängen an n8n.

## Done Criteria
- [ ] `npx vitest run test/state.test.js test/runlog.test.js test/run-pipeline.test.js test/watch.test.js test/watch-step.test.js` → exit 0
- [ ] `actionlint .github/workflows/seo-reusable.yml` → keine Befunde
- [ ] `npm run lint` → exit 0
- [ ] `git status`: nur Affected Files

## STOP Conditions
- Eine Änderung an Prompts, `claude.js`, `budget.js` oder `measure.js` (außer Import) wäre nötig.
- Der Ersatz des Index-Schritts im Run-Modus würde den Gate-Ablauf ändern.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Delegate spec
## Task: seo-cli Etappe A2, Wächter und Laufbericht
**Goal:** `seo watch` ohne LLM mit Alarmen ohne Wiederholung, `last-run.json`/`runs.jsonl`/`alerts.json` als Stand, Workflow-Eingabe `mode`. Done Criteria grün.
**Context:** Plan oben. `checkIndexStatus` in `src/steps/index-check.js`, `queryPageTotals` und `urlToSlug` aus Etappe A.2 (`src/lib/gsc.js`, `src/lib/measure.js`), `commitState` in `src/lib/state.js`, Workflow `.github/workflows/seo-reusable.yml`.
**Steps:** 1 bis 5.
**Done criteria / STOP:** siehe oben.
