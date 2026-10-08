# Etappe B.1: Signal-Speicher, SERP-Adapter mit AI-Overview-Signal

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat <plan-base>..HEAD -- src/ test/` (plan-base is the commit the worktree was created from).

## Meta
- Planned 2026-10-07 on seo-cli main (after #82).
- Teil von `docs/plans/2026-10-06-system-architecture.md`, Etappe B. B.1 baut die Adapter-Schnittstelle und den Signal-Speicher und stellt SerpAPI als ersten Adapter um. GSC und Index-Status folgen als B.2, weitere Quellen (Bing, Suchvorschläge, Trends) in Etappe H. Die Adapter-Schnittstelle kommt jetzt, nicht erst ab der dritten Quelle (Nutzerentscheidung 2026-10-06).
- Status: Spec

## Problem
1. Laut Feldstudie sinken organische Klicks um 38 %, wenn eine AI Overview erscheint, stärker bei rein informativen Suchanfragen. SerpAPI liefert das Feld `ai_overview` mit, seo-cli liest es nicht (`src/lib/serpapi.js` `getSerp` gibt nur Titel, Snippets, verwandte Suchen und Ähnliche Fragen zurück). Die Bewertung in `src/prompts/score.md` weiß davon nichts.
2. Jede Bewertung ruft SerpAPI neu ab, auch für Keywords, die vor einer Woche schon abgefragt wurden. Bei 60 Suchen pro Projekt und Monat ist das teuer.
3. Es gibt keinen gemeinsamen Ort für externe Signale mit Ablaufdatum.

## Goal
- Adapter-Schnittstelle `{ name, ttlDays, fetch(key, ctx) }` und Signal-Speicher `seo/signals/<name>.json` mit Zeitstempel pro Schlüssel.
- SERP als erster Adapter: liefert zusätzlich `features` (`ai_overview`, `ai_overview_cites_us`, `answer_box`, `local_pack`, `shopping`, `videos`) und wird 30 Tage gecacht. Ein Cache-Treffer kostet keine Suche.
- Bewertung: Die Features gehen in den Prompt, und eine feste Regel nach dem Prompt senkt den Score informativer Keywords mit AI Overview um 2 (nicht unter 0), außer die AI Overview zitiert die eigene Domain schon. Kauf- und Vergleichsabsicht bleiben unberührt.
- Das Keyword speichert `serp_features`, damit Etappe A.2 später auswerten kann, ob Seiten mit AI Overview anders abschneiden.

## Solution

### Approach
- `src/lib/signals/store.js`: `loadSignals(name, cwd)`, `getFresh(name, key, ttlDays, now)`, `putSignal(name, key, value, now)`, `saveSignals(name, cwd)`. Datei `seo/signals/<name>.json` = `{ version: 1, entries: { [key]: { fetched_at, value } } }`. Einträge älter als das Doppelte der TTL werden beim Speichern entfernt.
- `src/lib/signals/index.js`: `fetchSignal(adapter, key, ctx)` = frischer Cache-Eintrag oder `adapter.fetch` plus `putSignal`. Fehler eines Adapters werden geworfen wie heute (Aufrufer fangen sie bereits).
- `src/lib/signals/serp.js`: Adapter `serp`, `ttlDays: 30`, Schlüssel `<locale>:<gl>:<keyword klein>`. `fetch` ruft die bestehende Logik von `getSerp` auf (Budget, Account-Prüfung, Rückbuchung bleiben in `src/lib/serpapi.js`) und ergänzt `features`. `ai_overview_cites_us`: irgendein `ai_overview.references[].link` (oder `sources`) enthält den Host von `base_url`. Fehlt `ai_overview`, alles `false`.
- `getSerp(keyword, opts)` behält seine Signatur und Rückgabe (plus `features`). Ein optionaler Parameter `cwd` aktiviert den Cache. Die Aufrufer in `src/steps/discover.js` (`:224`, `:313`) geben `cwd` mit.
- `seo/signals/serp.json` kommt in `STATE_FILES`. Wird nur geschrieben, wenn sich etwas geändert hat.
- `src/steps/discover.js`: `serp_features` am Keyword speichern; Regel `adjustScoreForSerp(result, features)` in `src/lib/keywords.js` oder einer kleinen neuen Datei, mit `reason`-Zusatz "AI Overview, informational: -2".
- `src/prompts/score.md`: die Features im UNTRUSTED-Block und zwei Sätze, wie sie zu lesen sind. Die feste Regel bleibt maßgeblich, damit das Verhalten testbar ist.

### Verbindliche Ergänzungen aus der Challenge (gehen dem Text oben vor)
1. **Kein Score-Abzug, sondern Reihenfolge.** Ein Abzug am gespeicherten Score würde Keywords dauerhaft unter die Schwelle drücken (`skip`, nie neu bewertet, `src/steps/discover.js:146-148`, `:189`), obwohl AI Overviews kommen und gehen. Stattdessen bleibt der Score unverändert, und `getPending` (`src/lib/keywords.js`) sortiert nach einer effektiven Priorität: Score minus 2 bei `intent: informational` mit `serp_features.ai_overview` und ohne `ai_overview_cites_us`. Das Keyword bleibt `proposed` und kommt nur später dran. Die Regel heißt `serpPriority(keyword)` und liegt in `src/lib/keywords.js`.
2. **`intent` als feste Liste** im `SCORE_SCHEMA` (`src/steps/discover.js:29`): `informational`, `commercial`, `transactional`, `navigational`, `local`. Der Prompt sagt, dass die SERP-Merkmale nur zur Information dienen und die Reihenfolge im Code entschieden wird (kein doppelter Abzug durch das Modell).
3. **Felder von SerpAPI** (geprüft in https://serpapi.com/ai-overview): `ai_overview.text_blocks`, `ai_overview.references[].link`, `ai_overview.page_token`, `ai_overview.serpapi_link`, `ai_overview.error`. `ai_overview: true`, wenn das Objekt existiert und kein `error` hat. `ai_overview_cites_us`: ein `references[].link` mit Hostname gleich dem von `base_url` oder einer Subdomain davon (kein `includes`). Weitere Merkmale aus `answer_box`, `local_results`, `shopping_results`, `inline_videos` (vorhanden und nicht leer). Kein Nachladen über `page_token`.
4. **Cache-Begründung und Reihenfolge der Prüfungen:** Der Speicher ist Infrastruktur für Signale; die Ersparnis ist klein, weil `discover` bewertete Keywords nicht neu abfragt. `getSerp` liest den Cache **vor** der Prüfung von `SERPAPI_KEY`, Budget und Account, damit ein Treffer auch bei leerem Kontingent funktioniert. Die bisherige Abruflogik wird `fetchSerpUncached` (keine Zirkularität). Der Cache nutzt `process.cwd()` wie `src/lib/budget.js:31`, kein neuer `cwd`-Parameter.
5. **Sofort speichern:** `putSignal` schreibt die Datei sofort (synchron), damit bezahlte Suchen bei einem späteren `BudgetExceededError` nicht verloren gehen. Auch im Dry Run wird der Cache geschrieben (die Suche ist bezahlt, committet wird im Dry Run ohnehin nichts).
6. **Nur Daten speichern:** Im Cache stehen die extrahierten Felder (`top_titles`, `top_snippets`, `related_searches`, `people_also_ask`, `features` als Booleans), nie der AI-Overview-Text. Beim Lesen wird die Form geprüft, ein ungültiger Eintrag gilt als nicht vorhanden.
7. **Test der Reihenfolge-Regel** in `test/serp-priority.test.js`, in den Done Criteria.

### Steps
1. Signal-Speicher und `fetchSignal`. → verify: `npx vitest run test/signals.test.js` (frisch vs. abgelaufen, Speichern nur bei Änderung, alte Einträge entfernt, unlesbare Datei → Warnung und leerer Speicher)
2. SERP-Adapter, `getSerp` mit `features` und Cache. → verify: `npx vitest run test/serpapi.test.js test/serpapi-getserp.test.js test/signals-serp.test.js` (Features aus einer Beispielantwort mit `ai_overview`; Zitat der eigenen Domain erkannt; ohne `ai_overview` alles false; Cache-Treffer ruft weder `safeFetch` noch `adjustSerpapi`; abgelaufener Eintrag ruft neu ab; ohne `cwd` kein Cache)
3. Bewertung: `adjustScoreForSerp`, `serp_features` am Keyword, Prompt. → verify: `npx vitest run test/discover.test.js` und Test der Regel (informational + AIO → -2; zitiert uns → unverändert; commercial → unverändert; Untergrenze 0)
4. `STATE_FILES`, README, CLAUDE.md, FEATURE_AUDIT. → verify: `npx vitest run test/state.test.js`, `grep -n "signals" README.md CLAUDE.md`

### Affected Files
- neu: `src/lib/signals/store.js`, `src/lib/signals/index.js`, `src/lib/signals/serp.js`, `test/signals.test.js`, `test/signals-serp.test.js`
- geändert: `src/lib/serpapi.js`, `src/steps/discover.js`, `src/lib/keywords.js` (oder neue Datei für die Regel), `src/prompts/score.md`, `src/lib/state.js`, `test/serpapi.test.js`, `test/serpapi-getserp.test.js`, `test/discover.test.js`, `test/state.test.js`, `README.md`, `CLAUDE.md`, `FEATURE_AUDIT.md`

## Edge Cases
- SerpAPI liefert `ai_overview` nur mit `page_token` (Nachladen nötig): zählt als `ai_overview: true`, `ai_overview_cites_us: false`. Kein zweiter Abruf, der würde eine weitere Suche kosten.
- Cache-Datei fehlt oder ist kaputt: neu anlegen, Warnung.
- Dry run: Cache wird gelesen, aber nicht geschrieben.

## Done Criteria
- [ ] `npx vitest run test/serp-priority.test.js test/keywords.test.js test/signals.test.js test/signals-serp.test.js test/serpapi.test.js test/serpapi-getserp.test.js test/discover.test.js test/state.test.js` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `git status`: nur Affected Files

## STOP Conditions
- Eine Änderung an `src/lib/budget.js` oder an der Rückbuchungslogik wäre nötig.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.
