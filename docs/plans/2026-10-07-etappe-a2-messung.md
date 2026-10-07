# Etappe A.2: Änderungsbuch und Messung

> **Executor instruction:** Follow step by step, check each verify
> criterion before moving on. If a STOP condition occurs: stop and
> report, do not improvise. All commands run from `/Users/rafael/Developer/apps/seo-cli`.
>
> **Drift check (first):** `git diff --stat <HEAD at plan time>..HEAD -- src/ test/`
> The plan was written while `feature/monthly-new-page-cap` was in progress; it builds on main after that branch is merged. Reconcile cited lines against the live code; a mismatch in a cited function is a STOP condition.

## Meta
- Planned 2026-10-07 on seo-cli main `5708b3b` plus the open branch `feature/monthly-new-page-cap` (adds `pr_opened_at`, `createdAt` in `getPR`).
- Teil von `docs/plans/2026-10-06-system-architecture.md`, Etappe A (Messen).
- Challengers: siehe Challenge Result.
- Status: Spec

## Problem
seo-cli öffnet und merged Seiten und Rewrites, misst aber nicht, ob sie gewirkt haben. Ohne Messung gibt es kein Lernen (Etappe F) und keine Grundlage für Zurücknehmen. Heute speichert nur `improvements.json` ein Merge-Datum (`src/commands/run.js:258`), Keywords nicht (`:237`). GSC-Abfragen gehen nur relativ zu heute (`src/lib/gsc.js:152-158`), ein Fenster in der Vergangenheit ist nicht abfragbar. Die Ranking-CSVs sind gitignored und nur Schnappschüsse (`src/steps/track.js`), also keine Zeitreihe.

## Goal
- Jeder gemergte seo-PR (neue Seite oder Rewrite) bekommt einen Eintrag in `seo/changes.json`.
- Rewrites bekommen nach 28 und 56 Tagen je eine Messung gegen ein Ausgangsfenster und gegen eine Kontrollgruppe unveränderter Seiten, mit Urteil `positive | neutral | negative | insufficient_data`.
- Neue Seiten bekommen nach 28 und 56 Tagen ihre absoluten Werte (Impressionen, Klicks, Position), ohne Urteil, weil es kein Vorher gibt.
- Zwei negative Messungen eines Rewrites setzen `revert_candidate: true` und erzeugen eine Warnung im Bericht. Das eigentliche Zurücknehmen kommt in Etappe C.
- Die Messung braucht kein LLM und kostet nur GSC-Abfragen.
- Messbar: Nach dem ersten Lauf enthält `seo/changes.json` von rafaelalex.de Einträge für die gemergten PRs seit 2026-09-01, und der Bericht hat einen Abschnitt `measurement`.

## Non-Goals
- Kein automatisches Zurücknehmen (Etappe C).
- Keine Lernregeln, keine Kalibrierung (Etappe F).
- Keine Änderung am Dashboard und an n8n (eigener kleiner Schritt danach).

## Solution

### Approach
**Zeitfenster** (alle Daten als `YYYY-MM-DD`, `merge` = Merge-Datum):
- Ausgangsfenster: `merge-28` bis `merge-1`.
- Messung 28: `merge+8` bis `merge+35`. Messung 56: `merge+36` bis `merge+63`. Die ersten 7 Tage nach dem Merge zählen nicht (Deploy, Recrawl).
- Eine Messung ist fällig, wenn ihr Fensterende mindestens 3 Tage vor heute liegt (GSC-Verzug).

**Metriken pro Fenster und Seite:** Summe Klicks, Summe Impressionen, CTR = Klicks/Impressionen, Position impressionsgewichtet. Quelle: neue Funktion `queryPageTotals(property, { startDate, endDate })` in `src/lib/gsc.js` mit Dimension `['page']`, `rowLimit` = `GSC_MAX_ROWS`, auf Basis von `buildRequestBody` (`:142`). URLs werden normalisiert: Query und Fragment weg, abschließender Slash weg.

**Zuordnung URL zu Seite:** Nur bekannte Landingpages zählen. Slugs kommen aus `getExistingSlugs(config, cwd, locale)` (`src/lib/landings.js:9-31`) für Standard- und Counterpart-Sprache. Eine GSC-URL wird wie in `src/steps/improve.js:157-161` auf den Pfad nach `base_url` reduziert, ein `counterpart_url_prefix` wird für die Counterpart-Sprache abgezogen, Query, Fragment und abschließender Slash entfallen. URLs ohne bekannten Slug (Startseite, /preise, Blog) fließen nicht ein. `queryPageTotals` bekommt `pageFilter: base_url`.

**Kontrollgruppe (nur Rewrites):** Landingpages derselben Sprache, die keinen Eintrag in `changes.json` haben, dessen Merge in `merge-28` bis `merge+63` liegt (alle `urls` aller Einträge, also auch Counterparts, sind ausgeschlossen). Davon zuerst die Seiten mit ähnlichem Ausgangsniveau: Impressionen im Ausgangsfenster zwischen der Hälfte und dem Doppelten der Zielseite. Sind das weniger als 12, alle Seiten mit mindestens 50 Impressionen im Ausgangsfenster. Weniger als 12 Kontrollseiten → `insufficient_data` mit Grund `control`.

**Urteil (nur Rewrites, nur als Hinweis):** Für jede Seite `r = (Wert nachher + 1) / (Wert vorher + 1)`. Zielmetrik Klicks, wenn die Zielseite im Ausgangsfenster mindestens 20 Klicks hatte, sonst Impressionen; für die Kontrollen dieselbe Metrik.
- Zielseite unter 100 Impressionen im Ausgangs- oder Messfenster → `insufficient_data` (`volume`).
- Streuung der Kontrolle zu groß (90. durch 10. Perzentil von `r` über 4) → `insufficient_data` (`dispersion`), etwa nach einem Google-Update.
- `positive`: `r` über dem 90. Perzentil der Kontrolle **und** mindestens 1,3-mal der Median der Kontrolle. `negative`: unter dem 10. Perzentil **und** höchstens 0,7-mal der Median. Sonst `neutral`.
- Gespeichert: `r`, Median, 10. und 90. Perzentil, Zahl der Kontrollen, `effect = r / median`.
- Das Urteil ist ein Hinweis. `improve` wählt Seiten mit einem Ausreißer in den Daten aus, ein Teil der Bewegung danach ist Rückkehr zum Mittelwert. Deshalb die strengen Grenzen.

**Revert-Kandidat:** nur wenn d28 und d56 `negative` sind und `effect` in d56 höchstens 0,7. Einträge mit `overlap` werden nie Kandidat.

**Überschneidung:** Liegt der Merge eines anderen Eintrags für dieselbe Seite (Rewrite oder Counterpart) im Ausgangsfenster oder im Messfenster, wird die Messung `insufficient_data` (`overlap`). Überschneidungen über Themen-Cluster werden nicht erkannt (siehe Known Costs).

**Einträge:** `seo/changes.json` = `{ entries: [{ id, kind: 'new' | 'rewrite', slug, urls: [...], pr_url, merged_at, baseline: {...} | null, readings: { d28: {...} | null, d56: {...} | null }, revert_candidate: false }] }`. `id` = PR-URL.
- Neue Seite: entsteht im Abgleich (`reconcileState`), wenn ein Keyword-PR gemergt ist. `urls` aus `sitemap_slugs` (`src/steps/pr.js:67`) plus `base_url`. Das Keyword bekommt zusätzlich `published_at`.
- Rewrite: entsteht, wenn ein `improvements.json`-Eintrag `merged_at` bekommt (`src/commands/run.js:258`). `urls` = Standardsprache und, falls die Seite ein `alternate:` hat, der Counterpart.
- Merge-Datum immer `mergedAt.slice(0, 10)` aus `getPR`. Ohne echtes `mergedAt` entsteht kein Eintrag (der heutige Fallback `format(new Date())` in `:258` gilt nicht für das Änderungsbuch).
- **Eigener Nachtrag-Durchlauf** (nicht über die bestehende Schleife, die `published`-Keywords überspringt, `:229`): für jedes Keyword mit `pr_url` und Status `published` und jeden Improvement-Eintrag mit `pr_url` ohne Eintrag in `changes.json`, deren PR in den letzten 90 Tagen geöffnet wurde. Ein PR, der nicht gelesen werden kann, wird beim nächsten Lauf erneut versucht. Läuft nicht bei `--dry-run`.
- `baseline` wird bei der ersten fälligen Messung berechnet und gespeichert (dann steht das Ausgangsfenster sicher in GSC).

**Ablauf:** Neuer Schritt `src/steps/measure.js` in `seo run` direkt nach `reconcileState`, vor `discover`. Er rechnet alle fälligen, noch leeren Messungen und schreibt `changes.json`. GSC-Antworten werden in einem eigenen Cache mit Schlüssel `(property, startDate, endDate, pageFilter)` gehalten (der bestehende Cache in `gsc.js:152-170` kennt nur relative Fenster). Pro Eintrag sind das bis zu drei Abfragen, beim ersten Nachtrag für ein Projekt einige Dutzend, danach wenige pro Woche. Ist die Summe der Impressionen aller Landingpages in einem Fenster 0, gilt die Antwort als Fehler (falsche Property, Ausfall): Warnung, nichts gespeichert. Ein Fehler beim Messen oder Speichern ist eine Warnung, der Lauf geht weiter. `seo/changes.json` kommt in `STATE_FILES` (`src/lib/state.js`). Bei `--dry-run` wird gerechnet und berichtet, aber nichts geschrieben.

**Bericht:** `report.measurement = { entries, due, measured, verdicts: { positive, neutral, negative, insufficient_data }, insufficient_by_reason: { volume, control, dispersion, overlap }, revert_candidates: [slug], changed: [{ slug, kind, reading, verdict }] }`. Nur Zählungen und die in diesem Lauf geänderten Einträge, nicht das ganze Buch. Jeder neue Revert-Kandidat erzeugt eine Warnung.

### Steps
1. `src/lib/gsc.js`: `queryPageTotals` exportieren, Cache-Schlüssel mit den Daten. → verify: `npx vitest run test/gsc.test.js` mit Test für `requestBody` (Daten, Dimension `page`, rowLimit)
2. Neues `src/lib/measure.js` mit reinen Funktionen: `windowsFor(mergedAt)`, `isDue(window, today)`, `urlToSlug(url, config, slugsByLocale)`, `aggregatePages(rows)`, `quantile`, `selectControls(...)`, `verdictFor({ target, controls })`, `isOverlap(entry, entries, window)`, `isRevertCandidate(entry)`. → verify: `npx vitest run test/measure.test.js`, je ein Test pro Zweig: Fenstergrenzen; fällig/nicht fällig; URL zu Slug mit und ohne `counterpart_url_prefix`, unbekannte URL; impressionsgewichtete Position; Klicks vs. Impressionen als Zielmetrik; ähnliches Niveau vs. Rückfall auf alle; `volume`; `control`; `dispersion`; positiv nur mit beiden Bedingungen; negativ nur mit beiden Bedingungen; neutral; Überschneidung im Ausgangs- und im Messfenster; Revert-Kandidat nur bei zweimal negativ und Effekt ≤ 0,7; Perzentile an einer bekannten Reihe.
3. Neues `src/lib/changes.js` (`loadChanges`, `saveChanges`, `upsertEntry`), `STATE_FILES` erweitern, `reconcileState` legt Einträge an und speichert `published_at`, Nachtrag der letzten 90 Tage. → verify: `npx vitest run test/changes.test.js test/run-pipeline.test.js test/state.test.js`, Tests: Eintrag für gemergtes Keyword mit URLs aus `sitemap_slugs`; Eintrag für gemergten Rewrite mit Counterpart-URL; kein Eintrag ohne echtes `mergedAt`; kein doppelter Eintrag beim zweiten Lauf; Nachtrag erfasst `published`-Keywords und alte Improvements, ignoriert PRs älter als 90 Tage, wiederholt einen nicht lesbaren PR beim nächsten Lauf.
4. `src/steps/measure.js` und Aufruf in `src/commands/run.js` nach `reconcileState`; `report.measurement`; Warnung pro neuem Revert-Kandidaten; Revert-Kandidat erst bei negativ in d28 und d56. → verify: `npx vitest run test/measure-step.test.js test/run-pipeline.test.js`, GSC an der Modulgrenze gemockt (Muster `test/track.test.js:6-7`): fällige Messung wird gerechnet und gespeichert; nicht fällige bleibt leer; neue Seite bekommt Werte ohne Urteil; Revert-Kandidat und Warnung; GSC-Fehler und leere Antwort → Warnung, Lauf geht weiter, nichts gespeichert; `--dry-run` schreibt nichts; Bericht enthält nur Zählungen und geänderte Einträge.
5. README und CLAUDE.md: `changes.json` in der Tabelle der Statusdateien, Abschnitt Messung (Fenster, Kontrolle, Urteil, Grenzen), `report.measurement`. `FEATURE_AUDIT.md`: Zeilen mit den Test-IDs. → verify: `grep -n "changes.json" README.md CLAUDE.md`

### Affected Files
- neu: `src/lib/measure.js`, `src/lib/changes.js`, `src/steps/measure.js`, `test/measure.test.js`, `test/changes.test.js`, `test/measure-step.test.js`
- geändert: `src/lib/gsc.js`, `src/lib/state.js`, `src/commands/run.js` (`reconcileState`, Aufruf, Bericht), `test/gsc.test.js`, `test/run-pipeline.test.js`, `test/state.test.js`, `README.md`, `CLAUDE.md`, `FEATURE_AUDIT.md`

### Conventions
- Reine Funktionen in `src/lib/measure.js`, I/O nur in `src/steps/measure.js`.
- GSC-Mock wie `test/track.test.js:6-7`, googleapis-Mock wie `test/gsc.test.js:56-61`.
- Statusdateien mit `JSON.stringify(x, null, 2) + '\n'`.

## Edge Cases
- Seite in GSC nicht vorhanden: Werte 0, bei Rewrites `insufficient_data` (`volume`).
- Rewrite einer Seite mit Counterpart: gemessen wird die Standardsprache.
- GSC-Kontingent: bis zu drei Abfragen pro Eintrag, beim ersten Nachtrag einige Dutzend pro Projekt, weit unter dem Tageslimit.

## Known Costs
- Viele Urteile werden bei kleinen Seiten `insufficient_data` sein. Das ist ehrlich und für Etappe F die richtige Datenlage.
- Die Urteile sind Hinweise, kein Beweis: Kontrolle nicht zufällig, Rückkehr zum Mittelwert, beide Messungen teilen das Ausgangsfenster. Die strengen Grenzen machen Fehlalarme selten, dafür werden echte kleine Effekte übersehen.
- Überschneidungen über Themen-Cluster (neue Nachbarseite nimmt der Zielseite Impressionen) werden nicht erkannt, weil es keine verlässliche Cluster-Zuordnung pro Seite gibt.
- Auf drei kleinen Seiten wird ein großer Teil der Messungen `insufficient_data` sein. `insufficient_by_reason` macht das sichtbar. Etappe F muss deshalb über Projekte und Änderungsarten zusammenfassen statt einzelne Seiten zu bewerten.

## Done Criteria
- [ ] `npx vitest run test/gsc.test.js test/measure.test.js test/changes.test.js test/measure-step.test.js test/run-pipeline.test.js test/state.test.js` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `git status --short -- src test README.md CLAUDE.md FEATURE_AUDIT.md`: nur Affected Files

## STOP Conditions
- `reconcileState` oder `getPR` weichen von der Beschreibung ab (Branch `feature/monthly-new-page-cap` noch nicht gemergt).
- Eine Änderung an Prompts, `claude.js` oder `budget.js` wäre nötig.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Challenge Result
Konsolidierung: 14 Einwände (Architektur 7, Risiko 7), 10 nach Dedupe.
- **Übernommen (Architektur + Risiko):** Urteil zu locker: 10./90. Perzentil plus Mindest-Effekt, mindestens 12 Kontrollen, Urteil als Hinweis, Revert-Kandidat nur mit Effekt ≤ 0,7.
- **Übernommen (Architektur + Risiko):** Rückkehr zum Mittelwert und Auswahlverzerrung: Kontrollen mit ähnlichem Ausgangsniveau, bekannte Kosten benannt.
- **Übernommen (Architektur + Risiko):** Überschneidungen auch im Ausgangsfenster und über Counterparts; Cluster-Überschneidung als bekannte Grenze.
- **Übernommen (Architektur + Risiko):** Nachtrag als eigener Durchlauf, Merge-Datum nur aus echtem `mergedAt`, nicht lesbare PRs werden wiederholt.
- **Übernommen:** Zuordnung URL zu Slug über bekannte Landingpages, Counterpart-Präfix, `pageFilter`.
- **Übernommen:** Rewrite-Einträge mit Counterpart-URL.
- **Übernommen:** eigener Cache für absolute Fenster, realistische Zahl der Abfragen.
- **Übernommen:** leere GSC-Antwort als Fehler, Fehler beim Messen oder Speichern nur Warnung.
- **Übernommen:** Bericht mit Zählungen, Gründen und geänderten Einträgen statt des ganzen Buchs.
- **Übernommen:** Streuungsgrenze für Fenster mit Google-Update.

## Delegate spec

## Task: seo-cli Etappe A.2, Änderungsbuch und Messung
**Goal:** `seo/changes.json` für jeden gemergten seo-PR, Messungen nach 28 und 56 Tagen, Urteil für Rewrites gegen Kontrollgruppe, Revert-Kandidaten im Bericht. Done Criteria grün.
**Context:** Plan `docs/plans/2026-10-07-etappe-a2-messung.md`, Abschnitte Problem, Approach, Steps. `reconcileState` in `src/commands/run.js` (~`:220-262`), `getPR` in `src/lib/github.js:47`, `buildRequestBody` in `src/lib/gsc.js:142`, `localeUrlPath` in `src/lib/config.js:78`, `sitemap_slugs` in `src/steps/pr.js:67`.
**Affected files:** siehe Affected Files.
**Out of Scope:** Prompts, `claude.js`, `budget.js`, Dashboard, Workflow, n8n.
**Steps:** 1 bis 5 in dieser Reihenfolge.
**Done criteria (all):** siehe Done Criteria. Nur gefilterte Tests.
**STOP conditions:** siehe STOP Conditions.
