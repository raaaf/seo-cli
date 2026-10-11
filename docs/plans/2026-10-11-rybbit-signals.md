# Rybbit als Signalquelle: Conversions, KI-Besucher, Verhalten je Landingpage, Wochenbericht

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat f418d5e..HEAD -- src/steps/measure.js src/steps/improve.js src/commands/improve.js src/steps/assess.js src/prompts/assess.md src/prompts/improve.md src/lib/config.js src/lib/state.js src/lib/signals src/lib/safe-fetch.js .github/workflows/seo-reusable.yml src/commands/run.js`
> If an in-scope file has changed since the plan was created: reconcile the current state against the live code; on a mismatch, that is a STOP condition.

## Meta
- Planned at: commit `f418d5e`, 2026-10-11
- Challengers: ran architecture and risk (always). Skipped product and simplicity: the user set the scope (mail, measurement, improve, assessment context, weekly report). Skipped design: the only UI is mail copy, built in n8n. Drift check run by the orchestrator: none.
- Status: Spec

## Problem
seo-cli sieht nur, was vor dem Klick passiert (GSC, Bing). Ob eine Landingpage Registrierungen, Käufe oder Anfragen bringt und ob KI-Suchen auf sie verlinken, weiß es nicht. Rybbit (selbst gehostet, `https://tracking.maki-it.de`, 2.9.1) misst das auf allen Projekten. Einen Wochenbericht aus Rybbit gibt es nicht.

## Goal
- Jeder Wochenlauf liefert pro Landingpage Einstiege, Absprungrate, Verweildauer, Haupt- und Neben-Conversions und KI-Einstiege; die SEO-Mail zeigt die Top-Seiten.
- d28/d56-Messungen tragen dieselben Werte für ihr Fenster; das Urteil bleibt GSC.
- `improve` bevorzugt bei sonst qualifizierten Seiten die mit genug Einstiegen und belegt null Conversions.
- Die Bewertung bekommt Einstiege, Absprungrate, Verweildauer der Seite, wenn es Einstiege gab.
- Montags 08:00 ein Rybbit-Wochenbericht per Mail für die eigenen Seiten (Teil B).
- Fällt Rybbit aus (Key, Ziel, Site), steht das sichtbar als Aufgabe in der Mail, nie nur als Warnung.
- Begriff: „Einstiege“ = Sessions, die auf dieser Seite beginnen (Rybbit `entry_page` `count`). zeit kann den Bonus erst bekommen, wenn `signup_completed` ankommt (Maintenance Notes).

## Non-Goals
- Keine Entscheidung allein aus Rybbit. Keine Nutzer-, Session- oder IP-Daten, nur Aggregate.
- Keine Änderung am Tracking-Code der Projekte in diesem Plan (Befunde dazu unter Maintenance Notes).
- Kundenseiten (buk-stuttgart, fim-, siera-vertrieb, stiftungs-navigator, goldene-strategie, marzinke) bleiben unangetastet und nicht im Bericht.

## Bestand in Rybbit (geprüft 2026-10-11, 30 Tage)
| Site | Sessions | Ziele | Befund |
|---|---|---|---|
| zeit (3) | 63 | 8 (Signup 0, Projekt erstellt 2) | `signup_completed` kommt nie an, Code sendet es per Session-Flash |
| events (15) | 841 | 7 inkl. Event veröffentlicht 10, Wizard gestartet 5 | 6471 eigene `web_vital`-Events, Rybbit-Web-Vitals aus |
| Shop (19) | 47 | keine | **angelegt:** Kauf abgeschlossen `/order/success`, Warenkorb `/cart`, Produkt `/shop/*` (rückwirkend: 21 / 3 / 0) |
| Portfolio (2) | 104 | keine | **angelegt:** Anfrage gesendet `/danke` (0) |
| Topf-Secret (27) | 3 | keine | **angelegt:** App-Import geklickt (Event `app_import_click`) |
| Sprachverliebt (26) | 9 | keine | sendet keine Events |
Alle Seiten: Bots geblockt, IP nicht gespeichert, User-IDs gesalzen, keine IP-Ausschlüsse (eigene Besuche zählen mit).

## Solution

### Approach
**Conversion-Modell:** pro Projekt Hauptziel plus Nebenziele, zugeordnet über die Einstiegsseite. Bei kleinen Zahlen geben Nebenziele früher Signal.

| Projekt | Hauptziel | Nebenziele |
|---|---|---|
| zeit | Signup abgeschlossen | Preisseite besucht, Registrierung besucht |
| events | Event veröffentlicht | Wizard gestartet |
| Shop | Kauf abgeschlossen | Warenkorb angesehen, Produkt angesehen |
| Portfolio | Anfrage gesendet | keine |

**KI-Quellen:** Referrer `equals` je Host (`chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `www.perplexity.ai`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `copilot.com`) plus `utm_source` mit denselben Werten. Untergrenze, in der Mail so benannt.

**API (geprüft):** Bearer-Key; `metric?parameter=entry_page` (`count`, `bounce_rate`, `time_on_page_seconds`); `goals?filters=[entry_page equals <pfade>]` (`total_conversions` je Ziel, mehrere Pfadvarianten in einem `value`-Array); `metric?parameter=entry_page` mit Referrer-Filter für KI-Einstiege. Ziele werden rückwirkend berechnet.

### Steps
1. `src/lib/rybbit.js`: Client nach `src/lib/bing.js`: `RybbitError({ method, kind, status })` mit fester Meldung; `kind` `key_rejected` (401/403), `rate_limited` (429), `unavailable`, `error`; zwei Fehler in Folge oder `key_rejected` beenden Rybbit im Prozess. Nur `https`, Anfrage mit `redirect: 'manual'`, jede 3xx ist `error` (sonst würde `safeFetch` den Header an fremde Hosts weiterreichen). Funktionen `entryPages`, `aiEntryPages`, `goalsForEntry(site, paths[], window)`. → verify: Tests für Fehlerabbildung, Key nie in `message`, 3xx abgelehnt, Abbruch nach zwei Fehlern.
2. `src/lib/signals/rybbit.js`: Cache der **Rohantworten** im Signal-Store mit `cwd` (wie Bing), Key `<site>:<endDate>:<kind>`, TTL 7 Tage; Fenster endet am letzten vollen Sonntag, damit der Key eine Woche stabil bleibt. Reine Funktion `pageStats(raw, config, slugsByLocale)`: Pfade mit `base_url` zu URLs, über `urlToSlug` gruppiert (Locale und Slug als Key, Varianten `/x`, `/x/`, Query zusammengefasst), Ziele per Name. Fehlender Zielname oder fehlgeschlagene Abfrage: `null`, Warnung. Ein Ziel mit 0 Conversions auf der ganzen Site im Fenster gilt als `null` (nicht gemessen). `dryRun` schreibt nichts. `RYBBIT_SIGNALS_FILE` in `store.js`, Eintrag in `STATE_FILES` (`src/lib/state.js`). → verify: Tests für Gruppierung, Varianten, `null`-Regeln, Dry-Run ohne Schreiben.
3. Config (`src/lib/config.js`): `rybbit: { enabled: false, url: null, site_id: null, macro_goal: null, micro_goals: [] }`, Merge wie `bing`; aktiv nur komplett und mit Key, fehlender Key eine Warnung. → verify: Config-Test.
4. `src/commands/run.js` nach `measure`: `report.rybbit = { window, totals, ai_sources, pages, missing_goals }` (Top 10 nach Einstiegen, nur Seiten mit mindestens 5 Einstiegen) oder `report.rybbit = { error: <kind> }`. Zielabfragen nur für die Top 10 und für Seiten mit mindestens 30 Einstiegen. Fehler: Warnung plus `error`-Feld, das die Mail als Aufgabe zeigt („Rybbit liefert keine Daten: Schlüssel prüfen“). → verify: run-Tests grün.
5. `src/steps/measure.js`: ein Helper hängt `rybbit` an jede Rückgabe von `measureEntry` (alle vier Pfade); Fehler ergibt `rybbit: null`. Ein Nachfüllschritt ergänzt bei späteren Läufen nur das Feld `rybbit` von Lesungen mit `rybbit: null`, solange das Fenster nicht älter als 90 Tage ist; Verdict und GSC-Werte werden nie neu berechnet, eine kaputte `changes.json` wirft weiter (`changes.js`). → verify: Tests: Verdict gleich, Feld gesetzt, `null` nachgefüllt.
6. `src/commands/improve.js` (`prepareImprove`) lädt die Stats und übergibt sie an `selectPage` (`src/steps/improve.js`, Parameter `engagement`). Bonus `score * 1.25` mit Zusatz am `reason` (auch wenn er nicht greift: `Rybbit: <n> Einstiege, <m> Conversions, kein Bonus`, damit die Schwelle später aus Daten geprüft werden kann) nur wenn `sessions >= 30` und `macro === 0` und `micro === 0` (beide nicht `null`). `improve.md` bekommt `{{engagement}}`: nur Zahlen und bekannte Slugs, durch `sanitizeUntrusted`, ohne Daten byte-identisch. → verify: Tests für 29/30 Einstiege, Conversion 1/0, `null`-Ziel ohne Bonus, Prompt unverändert ohne Rybbit; `node bin/seo.js improve --dry-run` in zeit läuft durch.
7. `src/steps/assess.js`/`assess.md`: `{{engagement}}` für die erste URL, nur wenn sie Einstiege hat, sonst Platzhalter leer. → verify: Test.
8. `seo-reusable.yml`: `RYBBIT_API_KEY` an allen drei Stellen wie Bing (Secret in `workflow_call`, 1Password-Schritt nicht fatal, Export mit Vorrang des Repo-Secrets), nicht im Watch-Schritt. Payload `rybbit: ($report.rybbit // null)`. CLAUDE.md: Absatz **rybbit**, State-Tabelle. → verify: grep.
9. Orchestrator nach Merge: zuerst nur zeit aktivieren und `node bin/seo.js run --dry-run` prüfen (Größe von `seo/signals/rybbit.json` unter 50 KB), dann `rybbit:`-Block in die anderen drei `seo.config.yaml`, Pins in events und zeit, SEO-Mail-Abschnitt „Was die Seiten bringen“ (Top 5, KI-Besucher mit Quellen, Hinweis Untergrenze). → verify: `node bin/seo.js run --dry-run` in zeit zeigt `report.rybbit`; n8n-Test.

### Teil B: Rybbit-Wochenbericht (n8n, ohne seo-cli)
10. n8n-Workflow „Rybbit: Wochenbericht“, montags 08:00 Europe/Berlin, Sites 3, 15, 19, 2, 26, 27. Je Site, letzte Woche gegen Vorwoche: Sessions, Nutzer, Absprungrate, Haupt- und Nebenziele, Top 5 Seiten, Top 5 Quellen mit KI-Markierung, größte Veränderung als ein Satz. Kopf: ein Satz pro Site, Seiten ohne Veränderung zusammengefasst. Stil wie die SEO-Mail (Aufgaben zuerst: z. B. „Ziel X meldet seit 4 Wochen 0“). Key als n8n-Credential (Header Auth), angelegt von Rafael. Aufgabe im Bericht, wenn eine Site in der Woche 0 Events oder ein Hauptziel 4 Wochen 0 meldet. Fehler-Workflow schickt eine Mail, wenn der Bericht selbst scheitert. → verify: Testlauf mit Pin-Daten, dann ein echter Lauf an Rafael.

### Affected Files
- neu: `src/lib/rybbit.js`, `src/lib/signals/rybbit.js`, `test/rybbit.test.js`, `test/rybbit-signals.test.js`
- `src/lib/signals/store.js`, `src/lib/state.js`, `src/lib/config.js`, `src/commands/run.js`, `src/steps/measure.js`, `src/commands/improve.js`, `src/steps/improve.js`, `src/prompts/improve.md`, `src/steps/assess.js`, `src/prompts/assess.md`, `.github/workflows/seo-reusable.yml`, `CLAUDE.md`
- Tests: bestehende `test/improve*.test.js`, `test/measure*.test.js`, `test/assess.test.js`, `test/config*.test.js`, `test/state*.test.js`

### Conventions
- Externer Client wie `src/lib/bing.js`; Signal-Adapter wie `src/lib/signals/bing.js` mit `getFresh`/`putSignal` und `cwd`.
- Prompt-Platzhalter byte-identisch ohne Daten, wie `{{icp}}` (`test/icp.test.js`).

## Edge Cases
- Rybbit nicht erreichbar: Warnung, Lauf geht weiter, Felder `null`, Nachfüllen später.
- Ziel umbenannt oder gelöscht: `null`, Warnung, nie 0.
- Einzelne Session mit Conversion: in Mail und Bericht erst ab 5 Einstiegen pro Seite.

## Known Costs
- `improve` nutzt Rybbit trotz kleiner Zahlen (Nutzerentscheidung): Schwelle 30, `null`-Regeln und nur Bonus auf GSC-Kandidaten begrenzen das.
- Zielabfragen: bis zu 40 Aufrufe pro Lauf und Projekt; bei Fehlern greift der Zwei-Fehler-Abbruch.

## Done Criteria
- [ ] `npx vitest run` → exit 0, neue Tests aus den Schritten 1-7
- [ ] `npm run lint` → exit 0
- [ ] Ohne `rybbit.enabled` alle Prompts byte-identisch (Test)
- [ ] `git status`: nur Dateien aus der Liste

## STOP Conditions
- API-Felder weichen von den dokumentierten ab.
- `selectPage`, `prepareImprove` oder `measureEntry` weichen vom Planstand ab.
- Ein Schritt bräuchte eine Datei außerhalb der Liste.

## Maintenance Notes
- zeit: `signup_completed` per Session-Flash (`app/Support/AnalyticsEvent.php`, gerendert in `app-wrapper.blade.php:318`) kommt nicht an. Prüfen, ob der Redirect nach der Registrierung die Flash-Session verbraucht, bevor eine Seite mit dem Wrapper rendert. Ohne Fix bleibt das Hauptziel `null`.
- events und Portfolio schicken Web Vitals als eigene Events (6471 bzw. 854 im Monat); Rybbits eingebaute Web Vitals sind aus. Umstellen spart Events und bringt fertige Auswertung.
- Eigene Besuche zählen mit (keine IP-Ausschlüsse); Test-Signups verfälschen Ziele.
- Sprachverliebt sendet kein Event für den App-Store-Klick.
- Schwelle 30 und Bonus 1.25 prüfen, sobald eine Seite 200 Einstiege im Monat hat.

## Challenge Result
- **Evaluation (ready with changes), übernommen:** sichtbarer Rybbit-Ausfall in der Mail, Fehler-Workflow und 0-Events-Hinweis im Wochenbericht, Begriff Einstiege, Gate nur zeit zuerst plus Größencheck, Bonus-Begründung immer loggen, Zielabfragen begrenzt, Nachfüllen ohne Neuberechnung. Ein eigener `rybbit_blind`-Alarm im Wächter: deferred, revisit wenn die Mail-Aufgabe zweimal übersehen wurde (Wächter ist out of scope).
- **Accepted:** Redirect leakt Bearer-Header (risk): `redirect: 'manual'`, nur https.
- **Accepted:** Cache-Key ändert sich jeden Lauf, `STATE_FILES` fehlt (risk + architecture, konvergent): Wochenfenster, Rohantworten, `state.js`.
- **Accepted:** Lesungen sind einmalig, Rybbit-Ausfall verliert Daten (risk + architecture, konvergent): Helper an allen Rückgaben, `null` plus Nachfüllen.
- **Accepted:** `null + null === 0` gibt falschen Bonus, nie feuernde Ziele lesen sich als 0 (architecture + risk, konvergent): Bonus nur bei bekannten Nullen, Site-weit 0 gilt als `null`.
- **Accepted:** `prepareImprove` liegt in `src/commands/improve.js`: in Liste und Drift-Check.
- **Accepted:** Pfade statt URLs, Locale, Pfadvarianten: Gruppierung über `urlToSlug` mit `base_url`.
- **Accepted:** Ziele anlegen ist eine Außenwirkung: vom Nutzer freigegeben („passe und optimiere gerne“), idempotent erledigt am 2026-10-11, Schritt entfällt.
- **Accepted:** `utm_source` und `equals`; eigener Traffic als Befund; Dry-Run schreibt nichts; eigener improve-Verify; Mail erst ab 5 Einstiegen; Workflow-Key an drei Stellen.
- **Accepted (abgeschwächt):** Bewertungskontext bei nicht indexierten Seiten (architecture, zur Diskussion): bleibt laut Nutzerentscheidung, aber nur bei Seiten mit Einstiegen.

## Delegate spec

## Task: Rybbit-Signale in seo-cli (Bericht, Messung, improve, Bewertung)
**Goal:** Mit `rybbit.enabled` liefern Lauf, Messung, `improve` und Bewertung Rybbit-Werte je Landingpage; ohne bleibt alles byte-identisch.
**Context:** Plan `docs/plans/2026-10-11-rybbit-signals.md` (API-Felder, Zieltabelle, KI-Hosts, `null`-Regeln). Vorbilder: `src/lib/bing.js`, `src/lib/signals/bing.js`, `test/icp.test.js`.
**Affected files:** siehe Plan „Affected Files“.
**Out of Scope:** watch, discover, generate, Projekt-Repos, n8n.
**Steps:** Plan-Schritte 1-8 in dieser Reihenfolge, jeder mit seinem verify; Schritte 9-10 macht der Orchestrator.
**Done criteria (all):** `npx vitest run` exit 0; `npm run lint` exit 0; git status nur Plan-Dateien.
**STOP conditions:** API-Felder weichen ab; Code weicht vom Planstand ab; verify zweimal rot; Datei außerhalb der Liste nötig.
