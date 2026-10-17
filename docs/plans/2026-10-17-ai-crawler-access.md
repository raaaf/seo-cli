# AI-Crawler-Zugang und strukturierte Daten im Watcher

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat 5fb5702..HEAD -- src/steps/watch.js src/lib/watch.js src/lib/config.js src/lib/landings.js src/lib/measure.js test/watch.test.js test/watch-step.test.js test/bing-audit-fixes.test.js` must be empty. If not, reconcile against the live code; a mismatch with the descriptions below is a STOP condition.

## Meta
- Planned at: commit `5fb5702` (seo-cli main), 2026-10-17.
- Herkunft: Abgleich mit der GEO-SEO Suite (agensi.io); deren Punkte Crawler-Zugang und JSON-LD fehlen bei uns.
- Nutzerentscheidungen 2026-10-17: (1) Live-Prüfung mit Vergleichsabruf, kein Cloudflare-Token. (2) Alerts nur für Such- und Abruf-Bots, Trainings-Bots nur im Report. (3) JSON-LD-Prüfung gehört in diesen Plan.
- Live-Stand 2026-10-17: rafaelalex.de, events.rafaelalex.de, zeit.rafaelalex.de liegen hinter Cloudflare und antworten mit 200 auf vorgetäuschte AI-Bot-UAs (von einer Heim-IP, nicht vom Runner). Alle drei liefern JSON-LD aus (FAQPage, BreadcrumbList, Person bzw. Organization). Der Plan baut eine Absicherung, keine Reparatur.
- Challengers: Architecture und Risk (immer). Product übersprungen (Umfang vom Nutzer entschieden, keine neue Nutzerfunktion), Design übersprungen (keine UI), Simplicity übersprungen (Umfang explizit entschieden). Drift check: vom Orchestrator gelaufen, leer.
- Status: Spec

## Problem
1. `seo watch` merkt nicht, wenn robots.txt oder die CDN-Firewall AI-Such-Bots aussperrt. robots.txt wird nur auf den Statuscode geprüft (`src/steps/diagnose.js:75`, `src/lib/diagnose.js:123`), es gibt keinen Regel-Parser, Live-Abrufe laufen nur als Googlebot (`src/lib/diagnose.js:53`).
2. Strukturierte Daten werden nirgends geprüft (kein `ld+json` in `src/` oder `test/`). Ein Template-Fehler, der JSON-LD oder FAQPage entfernt oder unparsbar macht, bliebe unbemerkt.

## Goal
- Täglich in `seo watch`, ohne LLM und Key: robots.txt je AI-Bot gegen alle Sitemap-URLs, Live-Abruf von Startseite und einer wechselnden Landingpage je Such-Bot-UA plus Browser-Vergleich.
- Ein Alert `ai_crawler_blocked` (Detail: Liste der Bots mit `via`, `paths`, `status`), ein Alert `structured_data` (Detail: Liste der Slugs mit Codes). Aggregiert wie `site_not_indexed`, keine Alert-Flut.
- `report.ai_crawlers` zeigt alle Bots, auch Trainings-Bots.
- Mit `watch.ai_crawlers: false` und `watch.structured_data: false` bitgleiches Verhalten zu heute; zwei identische Läufe lassen `seo/alerts.json` byte-gleich.

## Non-Goals
- Kein Cloudflare-API-Zugriff, keine Zitat-Messung bei AI-Plattformen, keine llms.txt.
- Keine Schema.org-Validierung über Parsbarkeit und `@type`-Präsenz hinaus.
- Keine Änderung an `diagnoseUrl` und an Zielprojekten.

## Out of Scope (Files)
- `src/lib/diagnose.js`, `src/steps/diagnose.js`: Index-Diagnose bleibt Google-bezogen.
- `.github/workflows/seo-reusable.yml`: Alerts gehen schon roh an den Webhook (`:505-536`).
- `src/lib/bing.js`, `src/lib/signals/`: unberührt.

## Solution

### Approach
Zwei reine Module plus zwei Check-Funktionen im Watch-Step, eingehängt wie Bing: `evaluateWatch` (`src/lib/watch.js:164`) bekommt `aiCrawlers = null, structuredData = null`, Semantik wie `bing` (`null` = nichts ändern, `{ disabled: true }` = eigenen Alert schließen, sonst Ergebnis). Vorlage `evaluateBing` (`:103-145`), Dispatch `:246-247`. Fehler beider Checks sind Warnungen, zählen nie zu `failures`/`watch_blind`, nie zu `errors`. Schließen bei disabled erfolgt über `kind`, nicht über eine feste ID-Liste.

**Bot-Liste** `AI_BOTS` in `src/lib/ai-crawlers.js`, je Eintrag `{ token, kind, live, robots }`:
| token | kind | live | robots |
|---|---|---|---|
| OAI-SearchBot, PerplexityBot, Claude-SearchBot, Claude-User | search | ja | ja |
| ChatGPT-User, Perplexity-User | search | ja | nein (Anbieter wenden robots.txt auf nutzerausgelöste Abrufe nicht oder nur teilweise an) |
| GPTBot, ClaudeBot, CCBot, Google-Extended | training | nein | ja (nur Report) |

UA: `Mozilla/5.0 (compatible; <token>/1.0)`. `watch.ai_crawlers_ignore: [token]` (Default `[]`) nimmt bewusst gesperrte Bots aus dem Alert.

**robots.txt (RFC 9309):** Abruf mit Browser-UA. BOM, CRLF, `#`-Kommentare und Zeilen vor dem ersten `User-agent` werden toleriert. Ein Bot nutzt die Gruppe, deren `User-agent`-Wert seinem Token exakt entspricht (case-insensitiv, kein Teilstring: `Claude` fängt nicht `Claude-User`), sonst `*`; gleichnamige Gruppen werden zusammengeführt. Längster passender Pfad gewinnt, bei Gleichstand `Allow`; `*` und `$` unterstützt; Pfade werden vor dem Vergleich percent-dekodiert verglichen; leeres `Disallow` erlaubt alles; unbekannte Direktiven (`Sitemap`, `Content-Signal`, `Crawl-delay`) ignoriert. Jeder 4xx = alles erlaubt. 5xx, Abruffehler oder Deadline = `unknown`, kein Zustandswechsel. Ausgewertet gegen `/` und den Pfad jeder Sitemap-URL aus `checkIndexStatus` (rein, keine Zusatzabrufe); ohne Einträge nur `/`. Eingabe auf 500 KiB gekürzt.

**Live-Regel:** Je URL ein Browser-Abruf (Chrome-UA) als Vergleich. Ein Such-Bot ist `blocked`, wenn er Status >= 400 bekommt (inklusive 402 Pay-per-Crawl, 451, 5xx) oder eine Challenge (Header `cf-mitigated: challenge`, oder `challenges.cloudflare.com` bzw. `Just a moment` im HTML) **und** der Browser-Abruf derselben URL 2xx liefert. Browser selbst blockiert oder fehlgeschlagen = `unknown` mit Warnung. **Kalibrierung gegen falsche Treffer vom Runner:** Ein Live-Befund öffnet den Alert nur für Bots, die von diesem Runner-Setup schon einmal `ok` waren (`ai_crawlers.ok_seen: { token: true }`, einmalig geschrieben). Wer noch nie `ok` war, steht nur im Report und erzeugt eine Warnung. Eine Sperre nur für spoofende Nicht-Verified-Bots wird so nicht zum Dauer-Alert.

**Abrufbudget:** 6 Such-Bots × 2 URLs + 2 Browser + 1 robots = 15 Abrufe, dazu bis zu 10 Landingpages plus pendende für strukturierte Daten, zusammen rund 25 bis 30. Alle laufen in einem gemeinsamen Pool: Nebenläufigkeit 5, Gesamt-Deadline 60 s; bei Deadline sind offene Abrufe `unknown`. Eine Warnung nennt die Bots und Seiten, die `unknown` blieben.

**Hysterese:** robots-Sperre öffnet sofort. Live-Sperre nach 2 Läufen in Folge (`bumpPending`, `src/lib/watch.js:61-63`, State `ai_crawlers.pending[token]`, gelöscht bei `ok`). Der Alert löst sich, wenn kein Bot mehr gesperrt ist; `unknown` ändert nichts. Ändert sich die Menge der gesperrten Bots (bzw. Slugs) bei offenem Alert, wird `detail` aktualisiert und der Alert landet in `report.alerts.updated` (wie eine geänderte Diagnose); `detail` ist sortiert, damit gleiche Mengen gleiches JSON ergeben. State persistiert nur `pending` und `ok_seen`, keinen Report.

**Strukturierte Daten:** Bis zu 10 Landingpages pro Tag (Default- und Counterpart-Locale), rotierend über `bingSection(urls, today, n)` (`src/steps/watch.js:143-148`, bekommt einen optionalen dritten Parameter `n = BING_URLS_PER_DAY`, sonst unverändert), plus jede Seite mit offenem oder pendendem Befund. URL zu Datei über `urlToSlug` (`src/lib/measure.js:69`), FAQ über `getExistingPages` (`src/lib/landings.js:39`). Abruf mit Browser-UA, Body-Cap 1 MB; gekürzter Body, Nicht-2xx oder fehlendes `<html`/`<title>` = `unknown`. Codes: `jsonld_missing`, `jsonld_invalid`, `faqpage_missing` (FAQ in der Frontmatter, kein `FAQPage`-Typ; `@graph`, Array-Wurzeln und `@type`-Arrays werden durchlaufen). Eine Seite kommt nach 2 Läufen in Folge mit Befund in den Alert (`structured_data.pending[slug]`), so dass ein noch nicht deployter Merge nicht sofort meldet. Slugs, die nicht mehr auf der Festplatte liegen, fallen aus Detail und State.

### Steps
1. `src/lib/ai-crawlers.js` (neu, rein): `AI_BOTS`, `botUserAgent`, `parseRobots`, `robotsVerdict(groups, token, path)`, `isChallenge({ status, headers, html })`, `liveVerdict({ bot, browser })`. → verify: `npx vitest run test/ai-crawlers.test.js` grün; ein Test je Regel: exakte Token-Gruppe vor `*`, `Claude` fängt nicht `Claude-User`, Merge, längster Treffer, Allow-Gleichstand, `*`, `$`, Percent-Encoding, leeres Disallow, unbekannte Direktive, BOM/CRLF/Kommentar, 401 = erlaubt, 5xx = unknown, Status 402 blocked, Challenge-Header, Challenge-HTML, Browser blockiert = unknown.
2. `src/lib/structured-data.js` (neu, rein): `extractJsonLd(html)`, `structuredDataFindings({ html, hasFaq, truncated })`. → verify: `npx vitest run test/structured-data.test.js` grün (`@graph`, Array-Wurzel, `@type`-Array, unparsbarer Block, FAQ ohne FAQPage, keine FAQ = sauber, gekürzt = unknown).
3. `src/lib/config.js:127-128`: `watch: { check_deploy: false, ai_crawlers: true, structured_data: true, ai_crawlers_ignore: [] }`. Der Code liest truthy (`config.watch?.ai_crawlers`), wie `checkDeploys`; fehlt `watch` im Config-Objekt (bestehende Tests), ist der Check aus. Der verschachtelte Merge existiert schon (`config.watch = { ...DEFAULTS.watch, ... }`, `src/lib/config.js:45`). → verify: neuer Fall im Config-Test: eine YAML mit nur `watch: { check_deploy: true }` ergibt `ai_crawlers: true` und `structured_data: true`; bestehende Watch-Tests machen keine Netzabrufe (laufen ohne Netz grün).
4. `src/lib/watch.js`: Eingaben `aiCrawlers`, `structuredData`; `evaluateAiCrawlers`, `evaluateStructuredData` nach Muster `evaluateBing`. → verify: neue Fälle in `test/watch.test.js`: robots öffnet sofort, live erst am 2. Tag, live ohne `ok_seen` öffnet nie, `ok_seen` wird einmalig gesetzt, ignore-Liste, Trainings-Bot öffnet nie, `unknown` hält Zustand, disabled schließt über `kind`, structured_data nach 2 Läufen, entfernter Slug fällt raus, zwei identische Läufe ergeben gleiches JSON.
5. `src/steps/watch.js`: `checkAiCrawlers`, `checkStructuredData` nach `checkBing` (`:247`), vor `evaluateWatch` (`:249`); injizierbar `fetchBot` (Default: `safeFetch` mit `AbortSignal.timeout(10000)`, gibt `{ status, headers, html, truncated }`), ein gemeinsamer Pool mit Nebenläufigkeit 5 und Deadline 60 s für beide Checks. `bingSection` bekommt den Parameter `n`. Report bekommt `ai_crawlers: { robots, search, training }` und `structured_data: { checked, findings }`. → verify: `npx vitest run test/watch-step.test.js test/bing-audit-fixes.test.js` grün mit neuen Fällen (Bot 403 + Browser 200, `ok_seen` gesetzt, zwei Tage → Alert; beide 403 → Warnung, kein Alert; `ai_crawlers: false` → kein `fetchBot`-Aufruf; Deadline → unknown).
6. Docs: `README.md:221`, `:244`, `:288` und `CLAUDE.md` Abschnitt **watch** um beide Alerts, `ok_seen` und die Schalter ergänzen. → verify: `grep -c "ai_crawler_blocked" README.md CLAUDE.md` je ≥1.
7. Probelauf lokal: `cd ~/Developer/web/rafaelalex.de && node ~/Developer/apps/seo-cli/bin/seo.js watch --dry-run --report /tmp/watch.json` → verify: `jq '.ai_crawlers, .structured_data' /tmp/watch.json` zeigt 10 Bots und geprüfte Seiten, `jq '.alerts.opened' ` ohne neue Arten. Der erste echte Lauf auf dem Runner setzt `ok_seen`; das prüft der Nutzer nach dem Merge in `seo/alerts.json` der drei Projekte.

### Affected Files
- `src/lib/ai-crawlers.js`, `src/lib/structured-data.js` (neu)
- `src/lib/watch.js` (`evaluateWatch` `:164`, neue Evaluatoren)
- `src/steps/watch.js` (`bingSection` `:143`, `watch()` `:217-279`, neue Checks)
- `src/lib/config.js` (`:127-128`), Config-Test (ein neuer Fall)
- `test/ai-crawlers.test.js`, `test/structured-data.test.js` (neu), `test/watch.test.js`, `test/watch-step.test.js`, ggf. `test/bing-audit-fixes.test.js` (nur Umbenennung)
- `README.md`, `CLAUDE.md`

### Conventions
- Fakes als Parameter injizieren (`test/watch-step.test.js:40`), `vi.mock` nur für GSC wie bisher.
- Abrufe nur über `safeFetch`, Timeout per `signal`.
- Zusatzsignale warnen statt Fehler, wie `checkBing` (`src/steps/watch.js:184-187`).
- `--dry-run` schreibt nichts (bestehend über `saveAlerts`).

## Edge Cases
- Cloudflare-verwaltete robots.txt mit `Content-Signal`: Direktive ignoriert.
- robots.txt leitet um: `safeFetch` folgt bis 5 Hops.
- Runner-IP generell challenged: alles `unknown`, eine Warnung, keine Alerts.
- Projekt ohne Landingpages: nur Startseite live, strukturierte Daten übersprungen.
- Bot aus `AI_BOTS` entfernt: fällt aus Detail, `pending` und `ok_seen` werden beim nächsten Lauf bereinigt.

## Known Costs
- Rund 25 zusätzliche HTTP-Anfragen pro Projekt und Tag; sie erscheinen in der Cloudflare-Statistik als AI-Bot-Verkehr.
- Spoofing von Azure-IPs: eine Firewall, die nur verifizierte Bots sperrt, bleibt unerkannt (falsch negativ), und ein Bot, der vom Runner nie `ok` war, alarmiert nie. Bewusst statt Cloudflare-Token.
- robots-Regeln für ChatGPT-User und Perplexity-User werden nicht alarmiert, Quelle sind Sekundärquellen zum Anbieterverhalten.

## Done Criteria
- [ ] `npx vitest run test/ai-crawlers.test.js test/structured-data.test.js test/watch.test.js test/watch-step.test.js test/bing-audit-fixes.test.js` → exit 0
- [ ] `npm test` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `git status`: nur Dateien aus Affected Files geändert

## STOP Conditions
- Die zitierten Stellen in `src/steps/watch.js` / `src/lib/watch.js` / `src/lib/config.js` weichen ab.
- Ein Verify schlägt nach ernsthaftem Fix zweimal fehl.
- Der Fix braucht eine Datei aus Out of Scope.
- Probelauf (Schritt 7) meldet einen Befund: nicht anpassen, melden.

## Maintenance Notes
- Bot-Tokens ändern sich; die Liste steht nur in `AI_BOTS`. Spalte `robots` vor jeder Erweiterung gegen die Anbieterdoku prüfen.
- Reviewer: kein Bot-Abruf zählt zu `failures`; `aiCrawlers: null` fasst den State nicht an; kein volatiles Feld im State.

## Challenge Result
Konsolidierung: 16 Concerns → 11 nach Dedupe. Konvergent: falsche Treffer durch gespoofte UAs vom Runner (Architecture + Risk), Abrufe vor dem ersten `saveAlerts` (Architecture + Risk), State-Churn durch `last_report` (Architecture + Risk), Deploy-Verzug bei strukturierten Daten (Architecture + Risk).
- **Accepted:** Spoofing-Fehlalarm: `ok_seen`-Kalibrierung, Live-Befunde vorher nur Report.
- **Accepted:** Laufzeit vor `saveAlerts`: Nebenläufigkeit 5, Deadline 60 s, Trainings-Bots ohne Live-Abruf.
- **Accepted:** State-Churn: kein Report im State, `pending` bei `ok` gelöscht, Byte-Gleichheits-Test.
- **Accepted:** Deploy-Verzug und Wartungsseiten: 2-Lauf-Hysterese, nur 2xx-HTML zählt.
- **Accepted:** Alert-Flut: je ein aggregierter Alert pro Art, `ai_crawlers_ignore`.
- **Accepted:** Unvollständige Sperr-Status: jeder Status >= 400 bei Browser 2xx.
- **Accepted:** RFC-9309-Präzision: exaktes Token, jeder 4xx erlaubt, BOM/CRLF/Kommentare/Percent-Encoding.
- **Accepted:** robots nur an rotierenden Pfaden flackert: Auswertung gegen alle Sitemap-URLs.
- **Accepted:** Body-Cap 200000: 1 MB für JSON-LD, gekürzt = unknown.
- **Accepted:** Default-Semantik in Tests: truthy lesen, `fetchBot` mit Headern getrennt von `fetchLive`.
- **Accepted:** Nutzerausgelöste Fetcher ignorieren robots.txt: Spalte `robots` je Bot.
- **Evaluation, Accepted:** Strukturierte Daten im selben Abrufpool und unter derselben Deadline; Warnung mit `unknown`-Liste; `detail` offener Alerts wird aktualisiert; keine Umbenennung von `bingSection`.
- **Evaluation, Accepted (abgeschwächt):** Config-Merge: der Merge existiert schon (`src/lib/config.js:45`), es kommt nur ein Regressionstest dazu.
- **Deferred:** Alert, wenn die Crawler-Checks selbst dauerhaft `unknown` liefern (analog `bing_blind`): revisit when die Warnung in zwei Wochen Betrieb mehr als dreimal pro Projekt auftaucht.
- **Rejected:** Schalter `structured_data.require_faq`: keine Zielseite will FAQPage abschalten; wer es tut, setzt `structured_data: false`.
- **Rejected:** Erster Probelauf über `workflow_dispatch` auf dem Runner vor dem Einschalten: braucht eine Workflow-Änderung (out of scope); `ok_seen` deckt denselben Fall ab.

## Delegate spec

## Task: AI-Crawler-Zugang und JSON-LD-Prüfung in `seo watch`
**Goal:** `seo watch` öffnet die aggregierten Alerts `ai_crawler_blocked` (Such-Bots) und `structured_data`, schreibt `report.ai_crawlers` und `report.structured_data`; mit beiden Schaltern aus bitgleich zu heute; zwei identische Läufe lassen `seo/alerts.json` byte-gleich.
**Context:** Muster `evaluateBing` `src/lib/watch.js:103-145`, Dispatch `:246-247`, `bumpPending` `:61-63`; `checkBing` `src/steps/watch.js:152-188`, `bingSection` `:143-148`, `watch()` `:217-279`; `urlToSlug` `src/lib/measure.js:69`; `getExistingPages` `src/lib/landings.js:39`; Config `src/lib/config.js:127-128`. Alle Regeln (Bot-Tabelle, robots, Live, Kalibrierung, Budget, Hysterese, strukturierte Daten) stehen im Abschnitt Approach dieses Plans und sind verbindlich.
**Affected files:** siehe Affected Files.
**Out of Scope:** `src/lib/diagnose.js`, `src/steps/diagnose.js`, `.github/workflows/seo-reusable.yml`, `src/lib/bing.js`, `src/lib/signals/`.
**Steps:** 1 bis 7 wie oben, jeweils mit Verify.
**Done criteria (all):** siehe Done Criteria.
**STOP conditions:** siehe STOP Conditions.
