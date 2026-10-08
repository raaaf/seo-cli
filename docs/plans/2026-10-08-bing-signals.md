# Bing als Signalquelle: KI-Sichtbarkeit und Zusatzsignal

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat eb0f7aa..HEAD -- src/ test/ .github/` must be empty.

## Meta
- Planned at: commit `eb0f7aa` (seo-cli main), 2026-10-08. Branch `feature/bing-signals`, worktree `apps/seo-cli-bing`.
- Teil von Etappe H (weitere Quellen) aus `docs/plans/2026-10-06-system-architecture.md`. Nutzt den Signal-Speicher aus B.1 (`src/lib/signals/store.js`).
- Nutzerentscheidung 2026-10-08: Bing dient der **KI-Sichtbarkeit** (Bing speist ChatGPT-Suche und Copilot) und als **Zusatzsignal**; die Search Console bleibt Hauptquelle.
- Key: 1Password `op://seo-cli/seo-cli/BING-WEBMASTER-API`, verifiziert 2026-10-08 (GetUserSites: events, rafaelalex.de, zeit; punktundpause.de wird gerade aus der GSC importiert).
- Challengers: Architecture und Risk (immer). Product, Design, Simplicity übersprungen (Ziel und Umfang vom Nutzer entschieden, keine UI außer Mailzeile).
- Status: Spec

## Problem
1. Niemand sieht, ob die Projekte im Bing-Index stehen, obwohl ChatGPT und Copilot daraus schöpfen. Bing kennt zum Beispiel `zeit.rafaelalex.de/preise` (zuletzt gecrawlt kürzlich, HTTP OK), Google indexiert sie nicht; die Diagnose aus #84 weiß davon nichts.
2. Bing-Suchanfragen sind lange, natürliche Fragen (Messung 2026-10-08: rafaelalex.de 352 Anfragen mit 428 Impressionen in rund sechs Monaten, events 231/294, zeit 86/92). Als Mengenquelle schwach, als FAQ- und Themenmaterial wertvoll: genau so fragen Menschen KI-Suchen.

## Goal
- `seo watch` prüft täglich je Projekt mit `bing.enabled`: Crawl-Fehler (`GetCrawlIssues`) und Crawl-Abdeckung der Sitemap-URLs (`GetUrlInfo`), Alarme `bing_crawl_issues` und `bing_site_not_crawled`.
- Die Diagnose aus #84 zeigt pro URL, ob Bing sie gecrawlt hat (Bing ja, Google nein spricht für eine Qualitäts- statt Technikfrage).
- `discover`/`generate` bekommen passende Bing-Fragen als FAQ- und Themenmaterial; im Startmodus (keine GSC-Kandidaten, `greenfield: true`) dürfen Bing-Anfragen auch Kandidaten sein.
- Ohne `bing.enabled` bitgleiches Verhalten.

## Non-Goals
- Keine URL-Einreichung über die Bing-API: IndexNow meldet schon an Bing (100 URLs pro Tag Kontingent wären zusätzlich, ohne Nutzen).
- Keine Zusammenführung von Bing- und GSC-Zahlen in `improve`, `measure` oder `traffic_drop` (Mengen zu klein, andere Zeitachsen).
- Keine KI-Zitat-Messung (eigene Quelle, später).

## Out of Scope (Files)
- `src/steps/improve.js`, `src/steps/measure.js`, `src/lib/measure.js`: keine Bing-Daten.
- `src/lib/claude-code.js`: Env-Allowlist bleibt; der Bing-Key darf nie an `claude -p` gehen (ist durch die Allowlist schon so, Test sichert es).

## Solution

### Approach
**Client** `src/lib/bing.js`: `bingRequest(method, params)` über `safeFetch` mit `AbortSignal.timeout(15000)`, Basis `https://ssl.bing.com/webmaster/api.svc/json/`, Key aus `process.env.BING_WEBMASTER_KEY` als Query-Parameter `apikey`. **Jede** Ausnahme (auch aus `safeFetch`, deren Meldungen die URL samt Key enthalten, `src/lib/safe-fetch.js:24,65`) wird in `BingError({ method, kind, status })` mit fester Meldung ohne URL umgepackt; `kind`: `key_rejected` (HTTP 400 mit `ErrorCode` 3 `InvalidApiKey`, gemessen 2026-10-08, sowie 401/403), `rate_limited` (429), `unavailable` (5xx, Timeout, Netz), `error`. `parseBingDate('/Date(ms)/')` → ISO-Datum, ein Datum vor 2000 (Bing liefert `/Date(-62135596800000)/`, Jahr 0001, für nie gecrawlte URLs, gemessen 2026-10-08) → `null`. **Gecrawlt** heißt: `LastCrawledDate` parst zu einem Datum; `HttpStatus` 0 ist kein Fehler. Funktionen: `getQueryStats(site)`, `getCrawlIssues(site)`, `getUrlInfo(site, url)`, `getUserSites()`. `site` = `config.bing.site_url` oder `base_url` mit Slash. Nach 2 Fehlern in Folge stoppt ein Lauf weitere Bing-Aufrufe (Sicherung), `key_rejected` sofort.

**Suchanfragen** (nur `seo run`, nicht der Wächter): Speicher aus B.1, Name `bing`, Datei `seo/signals/bing.json` (in `STATE_FILES`, `seo run` committet sie wie `serp.json`), Schlüssel `queries:<site>`, TTL 7 Tage. `getFresh`/`putSignal` werden direkt mit `cwd` aufgerufen (`fetchSignal` reicht `cwd` nicht durch, `src/lib/signals/index.js:6-9`; die Store-Schnittstelle bleibt unverändert). Wert: höchstens 200 Anfragen der letzten 180 Tage, je `{ query, impressions, clicks, position }`, über alle Wochenzeilen summiert bzw. nach Impressionen gewichtet gemittelt. **Vor dem Speichern** gefiltert: keine Anfrage mit `@`, mit einer Ziffernfolge ab 6 Stellen, mit Telefonnummer-Muster oder über 120 Zeichen; dazu `classifyQuery` aus `src/lib/conversational.js` gegen Tracker-Proben und Artefakte.

**Wächter** (`src/steps/watch.js`, Regeln `src/lib/watch.js`): mit `bing.enabled` und Key holt er live, ohne Cache: `GetUserSites` (Site fehlt: einmal Warnung, Merker `bing.site_missing_warned` in `alerts.json`, keine weiteren Bing-Aufrufe), `GetCrawlIssues` und `GetUrlInfo` für höchstens 30 Sitemap-URLs pro Tag. Auswahl zustandslos: Sitemap-URLs sortiert, Startindex `(Tagesnummer × 30) mod Anzahl`, Tagesnummer = `floor(Date.parse(today + 'T00:00:00Z') / 86400000)` aus dem `today`, das `watch()` schon bekommt (deterministisch testbar). URLs, die die Sitemap verlassen, fallen aus `bing.crawled` heraus (wie `known_indexed`). Ergebnis pro URL als Boolean in `alerts.json` unter `bing.crawled[url]` (ändert sich selten, also kaum Commits; das Datum selbst wird nicht gespeichert). Abdeckung = Anteil `true` über alle URLs, für die ein Wert vorliegt. Neuer Eingang `bing` an `evaluateWatch`: `null` (deaktiviert, kein Key, Site fehlt, Fehler) lässt Bing-Alarme und `bing.crawled` unverändert und zählt **nicht** in `failures`/`watch_blind` (`src/lib/watch.js:187-193` bleibt unberührt, Test).
- `bing_crawl_issues`: nur Probleme an URLs aus der Sitemap; öffnet nach 2 Tagen in Folge mit Problemen (`bing.issues_pending`, Muster `traffic_pending`), Detail = Anzahl plus erste drei URLs, schließt bei 0.
- `bing_site_not_crawled`: mindestens 5 bewertete URLs, unter 20 % gecrawlt an 2 Tagen in Folge öffnet, ab 50 % schließt.
- `bing_blind`: öffnet bei `key_rejected` sofort und nach 3 Tagen ohne einen erfolgreichen Bing-Aufruf (`bing.last_ok` in `alerts.json`), schließt beim nächsten Erfolg; ein Alarm, damit eine stille Bing-Lücke in der Mail auftaucht, aber nie `errors` und nie `watch_blind`.
- `bing` und die Warn-Merker kommen in `alerts.json`; `src/commands/watch.js` committet weiter nur `alerts.json` und `index-status.json`.

**Diagnose** (`src/steps/diagnose.js`): für die höchstens 10 diagnostizierten URLs ein direkter `getUrlInfo`-Aufruf (wenn Bing aktiv), Ergebnis als eigenes Feld `bing: { crawled }` am URL-Eintrag der Diagnose, **nicht** als Befund-Code: `codes` und `resultKey` (`resultKey` und `codes` in `diagnoseAlerts`, `src/steps/diagnose.js`) bleiben unberührt, damit Bing keine `updated`-Meldungen auslöst. Das Feld wird bei jedem Lauf am bestehenden URL-Eintrag aktualisiert, auch wenn `write()` nicht läuft, aber nur bei geändertem Wert (selten, also kaum Commits). Die Mail zeigt „Bing: gecrawlt“ oder „Bing: nicht gecrawlt“ pro URL (n8n, Orchestrator).

**Discover/Generate**:
- `bingQuestionsFor(keyword, queries)` in `src/lib/signals/bing.js`: Anfragen mit allen signifikanten Tokens des Keywords (Tokenisierung wie `src/lib/similarity.js`), höchstens 8 nach Impressionen. `generate.js` liest sie zur Laufzeit aus dem Speicher, **nicht** am Keyword gespeichert, und hängt sie an den bestehenden Wert `people_also_ask` an (`src/steps/generate.js:55`, Platzhalter `src/prompts/generate.md:35`). Kein neuer Platzhalter, ohne Bing ist der gerenderte Prompt bytegleich (Test).
- Startmodus: in dem Zweig, in dem `discover` heute auf Greenfield auffüllt (`ready < weekly_cap` und `greenfield: true`, `src/steps/discover.js` um Zeile 121-125), **vor** `discoverGreenfield`: Anfragen mit Position ≤ 20 und mindestens `max(5, config.min_impressions)` Impressionen werden Kandidaten, bis `weekly_cap` erreicht ist; der Rest wird wie bisher mit Greenfield aufgefüllt. Es gelten der Token-Duplikat-Schutz und `covered_by` aus der Bewertung; die Kannibalisierungsprüfung braucht GSC-Seitenzeilen und greift hier nicht (bewusst, dokumentiert). `scoreAndSave` (`src/steps/discover.js:201-222`, `source` fest `'gsc'` in Zeile 296) bekommt `source` als Parameter, Bing-Kandidaten tragen `source: 'bing'`.

**Konfiguration** (`src/lib/config.js`): `bing: { enabled: false, site_url: null }`. **Workflow**: ein eigener nicht fataler 1Password-Schritt lädt `BING_WEBMASTER_KEY` aus `op://<op_vault>/seo-cli/BING-WEBMASTER-API` (Run und Watch); ein Repo-Secret gleichen Namens gewinnt. Mit `bing.enabled` und ohne Key: einmal Warnung, Bing übersprungen.

### Steps
1. `src/lib/bing.js`. → verify: `npx vitest run test/bing.test.js` (Datum 0001 → null, Fehlerumpacken: Redirect-Schleife und kaputte URL aus `safeFetch` enthalten den Key nicht, 400 mit ErrorCode 3 → `key_rejected`, Sicherung nach 2 Fehlern, Site-URL)
2. Adapter `src/lib/signals/bing.js` (Aggregation, PII-Filter, `bingQuestionsFor`), `STATE_FILES`, Konfiguration. → verify: `npx vitest run test/signals-bing.test.js test/config.test.js test/state.test.js`
3. Wächter. → verify: `npx vitest run test/watch.test.js test/watch-step.test.js` (beide Alarme mit 2-Tage-Hysterese öffnen und schließen; `bing_blind` bei `key_rejected` und nach 3 Tagen ohne Erfolg; Pruning von `bing.crawled`; `bing.enabled: false` heißt null Bing-Aufrufe; `bing: null` ändert nichts und zählt nicht als Ausfall; Site fehlt → Warnung genau einmal; Abschnittswahl deterministisch; nur Sitemap-URLs zählen bei Crawl-Problemen; ohne `bing.enabled` kein Aufruf)
4. Diagnose-Feld. → verify: `npx vitest run test/diagnose.test.js test/diagnose-step.test.js` (Feld gesetzt, `codes` und `cause` unverändert, kein `updated` durch Bing allein)
5. Discover/Generate. → verify: `npx vitest run test/discover.test.js test/generate.test.js test/signals-bing.test.js` (Fragen-Zuordnung, Startmodus nur im Greenfield-Zweig und vor Greenfield, Schwelle 5 Impressionen, `source: 'bing'`, Prompt ohne Bing bitgleich)
6. Workflow, Env-Test, Doku. → verify: `actionlint .github/workflows/seo-reusable.yml`, `npx vitest run test/claude-code.test.js` (Bing-Key fehlt im Kind-Env), `grep -n "bing" CLAUDE.md README.md`
7. (Orchestrator) `bing: { enabled: true }` in den vier Projekten, n8n-Mail um das Bing-Feld ergänzen, `mode=watch` je Projekt. → verify: kein Fehler, Shop meldet einmal „site missing“ bis der Import durch ist.

### Affected Files
- neu: `src/lib/bing.js`, `src/lib/signals/bing.js`, `test/bing.test.js`, `test/signals-bing.test.js`
- geändert: `src/lib/config.js`, `src/lib/state.js`, `src/lib/watch.js`, `src/steps/watch.js`, `src/steps/diagnose.js`, `src/steps/discover.js`, `src/steps/generate.js`, `src/commands/run.js` (Abruf der Anfragen), `src/prompts/generate.md`, `.github/workflows/seo-reusable.yml`, passende Tests, `CLAUDE.md`, `README.md`

### Conventions
- Reine Teile getrennt vom Abruf wie `src/lib/signals/serp.js`; Abrufe über `safeFetch` mit Timeout; Untrusted-Daten nur in `<<<UNTRUSTED_*>>>`-Blöcken über `fillTemplate`.
- Alarmtexte englisch wie in `src/lib/watch.js`; Bing-Probleme sind Warnungen, nie `errors`.

## Edge Cases
- Bing tagelang nicht erreichbar: Bing-Alarme bleiben stehen, wie sie sind; keine neue Meldung.
- Neue Seiten, die Bing noch nicht kennt: zählen als nicht gecrawlt; die 2-Tage-Hysterese und die 20-%-Schwelle verhindern Alarme wegen einzelner neuer Seiten.
- Alle Repos sind privat (geprüft 2026-10-08); gefilterte Anfragen in `bing.json` sind trotzdem auf das Nötige beschränkt.

## Known Costs
- Bis zu 33 Bing-Aufrufe pro Projekt und Tag im Wächter, 1 pro Woche im Lauf; ganze Sitemap-Abdeckung erst nach einigen Tagen (rafaelalex.de rund 3, Shop 2).

## Done Criteria
- [ ] `npx vitest run test/bing.test.js test/signals-bing.test.js test/config.test.js test/state.test.js test/watch.test.js test/watch-step.test.js test/diagnose.test.js test/diagnose-step.test.js test/discover.test.js test/generate.test.js test/claude-code.test.js` → exit 0
- [ ] `npm run lint` → exit 0; `actionlint .github/workflows/seo-reusable.yml` → exit 0
- [ ] Bestehende Tests nur ergänzt; `git status`: nur Affected Files

## STOP Conditions
- `evaluateWatch` bräuchte mehr als einen neuen Eingang, oder die Schnittstelle des Signal-Speichers müsste sich ändern.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Challenge Result
Konsolidierung: 16 Punkte → 11. Konvergent (Architecture + Risk): `bing.json` wird vom Wächter nie committet und der 1-Tages-Cache ist wirkungslos; täglicher Commit durch den Crawl-Eintrag; „gecrawlt“ undefiniert.
- **Übernommen:** Crawl live ohne Cache, Booleans in `alerts.json`, Speicher nur für Anfragen im Lauf (beide).
- **Übernommen:** zustandslose Abschnittswahl statt Offset, 30 statt 100 URLs pro Tag (Architecture).
- **Übernommen:** „gecrawlt“ über das Datum, Jahr 0001 = nie gecrawlt, gemessen (beide).
- **Übernommen:** Key nie in Meldungen, `safeFetch`-Fehler umpacken, Test (Risk).
- **Übernommen:** Bing-Hinweis als eigenes Feld statt Code, kein Flattern der Diagnose, direkter Abruf für die diagnostizierten URLs (Architecture).
- **Übernommen:** `bing: null` außerhalb von `failures`, Plan-Aussage korrigiert (beide).
- **Übernommen:** 2-Tage-Hysterese, nur Sitemap-URLs bei Crawl-Problemen, einmalige Warnungen mit Merker (Risk).
- **Übernommen:** Sicherung nach 2 Fehlern, Fehlerform 400/ErrorCode 3 gemessen (Risk).
- **Übernommen:** PII-Filter vor dem Speichern (Risk); Fragen zur Laufzeit statt am Keyword (Architecture).
- **Übernommen:** Startmodus-Schutzschranken ehrlich benannt, `source` als Parameter, Schwelle 5 Impressionen (beide).
- **Übernommen:** `cwd` explizit beim Speicher (Architecture).
- **Übernommen (Evaluation):** `bing_blind` gegen stille Bing-Lücken, Pruning von `bing.crawled`, kein neuer Prompt-Platzhalter (bytegleich), Startmodus-Bedingung am echten Greenfield-Zweig, Bing-Feld der Diagnose bei jedem Lauf aktualisiert, Tagesnummer deterministisch.

## Delegate spec

## Task: Bing als Signalquelle
**Goal:** Mit `bing.enabled` prüft der Wächter Bing-Crawl-Probleme und -Abdeckung, die Diagnose zeigt pro URL den Bing-Crawl-Stand, discover/generate nutzen gefilterte Bing-Fragen; ohne Konfiguration bitgleich; alle Done Criteria grün.
**Context:** Abschnitt Solution (Client, Adapter, Wächter, Diagnose, Discover/Generate, Workflow); Muster `src/lib/signals/serp.js`, Wächter `src/steps/watch.js` (`evaluateWatch`-Aufruf), Diagnose `src/lib/diagnose.js:147`, PAA-Slot `src/prompts/generate.md:35`, Greenfield `src/steps/discover.js:123`, 1Password-Schritte `.github/workflows/seo-reusable.yml:121-138`.
**Affected files:** Abschnitt Affected Files.
**Out of Scope:** Abschnitt Out of Scope.
**Steps:** 1 bis 6 aus Steps, je mit verify. Schritt 7 macht der Orchestrator.
**Done criteria (all):** Abschnitt Done Criteria.
**STOP conditions:** Abschnitt STOP Conditions.
