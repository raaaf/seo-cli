# Voice of Customer: automatisches ICP-Dokument aus echten Kundenquellen

> **Executor instruction:** Follow step by step, check each verify
> criterion before moving on. If a STOP condition occurs: stop and
> report, do not improvise.
>
> **Drift check (first):**
> `git -C apps/seo-cli diff --stat 860b86d..HEAD -- src/ .github/ test/`
> `git -C apps/feedback-widget diff --stat 138f3e5..HEAD -- src/ routes/ config/`
> If an in-scope file has changed since the plan was created: reconcile the
> current state against the live code; on a mismatch, that is a STOP condition.

## Meta
- Planned at: seo-cli `860b86d`, feedback-widget `138f3e5`, 2026-10-06
- Challengers: noch nicht gelaufen (Plan v1)
- Status: Spec

## Problem
Generierte Seiten kennen die Zielgruppe nur über eine Zeile im Style-Doc. Ohne echte Kundensprache, Einwände und Belege schreibt Claude den Durchschnitt aller Marketingtexte. Genau solche austauschbaren Seiten trifft Googles Durchsetzung gegen "scaled content abuse" seit März 2026.

## Goal
Jeder wöchentliche `seo run` sammelt ohne Handarbeit neue Kundenstimmen, bereinigt sie von Personendaten und hält `seo/icp.md` aktuell. `generate`, `improve` und `score` bekommen das Dokument als `{{icp}}`. Messbar: Nach 4 Wochen hat events ein `seo/icp.md` mit mindestens 30 Corpus-Einträgen. Kein Corpus-Eintrag und keine generierte Seite enthält eine Mailadresse, Telefonnummer oder einen Kundennamen (Test plus Grep).

## Non-Goals
- Keine wörtlichen Zitate aus Widget-Feedback auf öffentlichen Seiten. Store-Reviews nur paraphrasiert, ohne Namen.
- Kein seitenspezifischer CTA (eigener Plan, baut hierauf auf).
- Keine Mails als Quelle (kaum Aufkommen, Postfachzugriff unverhältnismäßig).
- Keine Aufnahme von punktundpause.de in seo-cli. Das ist ein eigener Plan (Landing-Renderer, Sitemap, GSC, Config, Workflow). Dieser Plan macht nur den `endpoint`-Vertrag so allgemein, dass der Shop danach ohne neuen Adapter angebunden wird.
- Keine Auswertung von `event_feedback` (Gäste bewerten Events, nicht die App).
- Keine Änderung an den Datenschutzerklärungen (als Todo in Maintenance Notes).

## Out of Scope (Files)
- `apps/events/app/Models/EventFeedback.php`: falsche Quelle, siehe Non-Goals.
- `src/prompts/counterpart.md`, `src/prompts/greenfield.md`, `src/prompts/review.md`: bekommen vorerst kein `{{icp}}`, um den Umfang klein zu halten.
- `src/lib/serpapi.js` Quota-Logik (`MONTHLY_LIMIT`): nur nutzen, nicht ändern.

## Solution

### Approach
Alle Quellen werden in CI gezogen, nichts läuft lokal oder von Hand. Einmalige Einrichtung (Token, Secrets) ist erlaubt, wiederkehrende Handarbeit nicht.

| Quelle | Weg | Warum so |
|---|---|---|
| App Store | SerpAPI-Engine `apple_reviews` | Keine Zugangsdaten pro App nötig, funktioniert auch für fremde Apps und Wettbewerber |
| Google Play | SerpAPI-Engine `google_play_product` (Reviews) | Die offizielle Play-API liefert nur 7 Tage. Ein Play-Service-Account existiert nicht (nur FCM in `apps/events/config/services.php:101`) |
| Google Maps | SerpAPI-Engine `google_maps_reviews` | Für übernommene Projekte mit lokalem Geschäft |
| Eigene App-Daten (`endpoint`) | Ein fester Vertrag: `GET <url>?since=<ISO>` mit Bearer-Token liefert `[{id, body, rating?, created_at}]`, bereinigt schon auf dem Server. Erste Umsetzung im feedback-widget-Paket | Personendaten verlassen die Produktion nie. Jede App, die den Vertrag erfüllt, ist ohne neuen Adapter angebunden (später z. B. die freigegebenen Reviews im Shop punktundpause.de) |
| Testimonials | Lokale Datei im Projekt-Repo (rafaelalex.de) | Liegen schon im Repo |

Mails sind bewusst nicht dabei: Es kommen kaum Kundenmails an, und ein automatischer Zugriff auf das iCloud-Postfach wäre unverhältnismäßig.

Ablauf in `seo run`, vor `discover`:
1. Jede konfigurierte Quelle holt Einträge seit dem letzten Stand (`seo/voice/state.json`).
2. `scrub()` entfernt Mailadressen, Telefonnummern, IBANs, URLs mit Query-Strings und Grußzeilen.
3. Bereinigte Einträge (`{id, source, date, rating?, text}`, `id` = Hash) kommen dedupliziert in `seo/voice/corpus.jsonl`.
4. `seo/icp.md` wird neu erzeugt, wenn mindestens 10 neue Einträge da sind, das Dokument älter als 90 Tage ist oder fehlt und mindestens 5 Einträge existieren. Ein Claude-Aufruf mit neuem Prompt `src/prompts/icp.md`, Corpus im `<<<UNTRUSTED_VOICE_START>>>`-Block. Die Ausgabe hat feste Abschnitte: Zielgruppe und Auslöser, Aufgaben, Probleme, Einwände, Kundensprache (Phrasen, max. 12 Wörter, keine Namen), Alternativen und Unterschied, Belege. Jede Aussage nennt die Zahl der stützenden Einträge. Der Prompt verbietet erfundene Aussagen ohne Beleg im Corpus.
5. Corpus, State und `icp.md` landen im selben PR wie die Seiten (`src/steps/pr.js:33`).

Ohne Quellen und ohne Corpus wird `{{icp}}` zu einem leeren Hinweis. Es wird keine Persona erfunden.

**Übernommene Projekte:** `seo init` erkennt App-Store-, Play- und Google-Maps-Links auf der Website (`src/lib/detect.js`) und schreibt passende `voice.sources` in die Config. Optional nimmt `voice.competitors` Store- oder Maps-IDs von Wettbewerbern auf. Deren Reviews gehen nur in den Abschnitt "Alternativen und Unterschied" ein.

Config-Beispiel (events):
```yaml
voice:
  sources:
    - { type: app_store, id: "6761116655" }
    - { type: play, id: de.rafaelalex.events }
    - { type: endpoint, url: https://events.rafaelalex.de/feedback/export, token_env: VOICE_FEEDBACK_TOKEN }
  competitors: []
```
Secret per Umgebung: der in `token_env` genannte Name, für events `VOICE_FEEDBACK_TOKEN`.

### Steps
0. Verifikation der externen APIs: SerpAPI `apple_reviews`, `google_play_product` (Reviews), `google_maps_reviews`. Dafür Parameter, Sortierung "neueste zuerst" und Paginierung aus der SerpAPI-Doku prüfen. → verify: Kurzbericht mit Doku-URLs in der Appendix dieses Plans
1. `src/lib/voice/scrub.js` mit `scrub(text)` → verify: `npx vitest run test/voice-scrub.test.js`, ein Test pro Regel (Mail, Telefon, IBAN, URL-Query, Grußzeile)
2. Quellen-Adapter `src/lib/voice/sources/{serpapi-reviews,endpoint,testimonials}.js`, alle mit derselben Rückgabe. SerpAPI-Aufrufe über die bestehende Quota-Reservierung, höchstens 1 Aufruf pro Quelle und Lauf. → verify: `npx vitest run test/voice-sources.test.js`, HTTP an der Fetch-Grenze gemockt, je ein Test für Cursor-Filter und für Fehler, die nur diese Quelle überspringen
3. `src/steps/voice.js`: sammeln, bereinigen, deduplizieren, Rebuild-Regel, `icp.md` erzeugen. Neuer Prompt `src/prompts/icp.md`. → verify: `npx vitest run test/voice.test.js` mit Tests für die Rebuild-Regel (10 neu / 90 Tage / fehlt mit ≥5 / leer), Dedupe und dafür, dass ohne Quellen kein Claude-Aufruf passiert
4. `loadIcpDoc()` analog zu `loadStyleDoc()` (`src/steps/generate.js:85-103`), Obergrenze 8.000 Zeichen. `{{icp}}` in `generate.md`, `improve.md` und `score.md` einfügen, mit der Regel "Phrasen als Sprachvorlage, nie wörtlich zitieren, keine Namen". → verify: `npx vitest run test/generate.test.js test/improve.test.js`, je ein Test, dass das ICP im Prompt steht, und einer, dass ohne ICP der leere Hinweis steht
5. In `src/commands/run.js` den Voice-Step vor `discover` aufrufen. In `src/steps/pr.js:33` Corpus, State und `icp.md` mitcommitten. Neuer Befehl `seo voice [--dry-run]`. → verify: `seo voice --dry-run` in `apps/events` gibt die Zahl der Einträge pro Quelle aus
6. `src/lib/config.js` und `src/lib/detect.js`: Default `voice: null`, Store- und Maps-Links erkennen, `seo init` schreibt `voice.sources`. → verify: `npx vitest run test/config.test.js test/detect.test.js`
7. `.github/workflows/seo-reusable.yml`: optionales Secret `VOICE_FEEDBACK_TOKEN` (Option A über 1Password, Option B direkt). → verify: `actionlint` ohne Befund
8. feedback-widget: `GET /feedback/export?since=<ISO>`, Bearer-Token aus `config('feedback-widget.export_token')`, 404 ohne konfigurierten Token, Rate-Limit. Liefert den `endpoint`-Vertrag `[{id, body, created_at}]` (`category` als optionales Zusatzfeld) mit serverseitiger Bereinigung von Mail, Telefon und URL-Query. → verify: Feature-Test in `apps/events/tests/Feature/` für 401 ohne und mit falschem Token, 200 mit bereinigtem `body`, `since`-Filter
9. README und CLAUDE.md von seo-cli: Abschnitt "Voice of Customer" mit Config, Secrets und einmaliger Einrichtung → verify: `grep -n "voice" README.md`

### Affected Files
- seo-cli neu: `src/lib/voice/scrub.js`, `src/lib/voice/sources/*.js`, `src/steps/voice.js`, `src/commands/voice.js`, `src/prompts/icp.md`, `test/voice-*.test.js`, `test/voice.test.js`
- seo-cli geändert: `src/steps/generate.js` (85-103), `src/steps/improve.js`, `src/prompts/{generate,improve,score}.md`, `src/commands/run.js`, `src/steps/pr.js` (33), `src/lib/config.js` (DEFAULTS), `src/lib/detect.js`, `src/commands/init.js`, `bin/` (Befehl registrieren), `.github/workflows/seo-reusable.yml`, `README.md`, `CLAUDE.md`
- feedback-widget: `routes/web.php` oder neue `routes/api.php`, neuer Controller unter `src/`, `config/` (export_token), `src/FeedbackServiceProvider.php`
- events: `tests/Feature/FeedbackExportTest.php`, `.env.example` (nur Key-Name)

### Conventions
- Untrusted-Daten immer durch `sanitizeUntrusted()` (`src/lib/template.js:12`) und in einen `<<<UNTRUSTED_…>>>`-Block. Vorbild: `src/prompts/generate.md`, Kontext-Block.
- Externe HTTP-Aufrufe über `safeFetch` (`src/lib/safe-fetch.js`), Vorbild `src/lib/serpapi.js`.
- Tests mit vitest, Mocks nur an der HTTP- und Claude-Grenze (Vorbild `test/generate.test.js`).
- Keine Secrets im Code, nur Env-Namen.

## Edge Cases
- Quelle schlägt fehl: nur diese Quelle überspringen, Lauf geht weiter, Warnung im Log.
- SerpAPI-Quota erschöpft: Voice-Quellen zuerst überspringen, `discover` hat Vorrang.
- Eintrag ist nach `scrub()` leer oder kürzer als 20 Zeichen: wird verworfen.
- Endpoint liefert Felder außerhalb des Vertrags (z. B. `name`, `email`): werden vor dem Speichern verworfen, nur `id`, `body`, `rating`, `created_at` kommen in den Corpus.
- Englische und deutsche Reviews gemischt: `icp.md` wird in der Projektsprache (`locale`) geschrieben.
- Corpus wächst: `icp.md`-Prompt bekommt höchstens die neuesten 300 Einträge.

## Known Costs
- SerpAPI: etwa 9 Aufrufe pro Monat für events aus dem Kontingent von 240.

## Done Criteria
- [ ] `cd apps/seo-cli && npx vitest run test/voice-scrub.test.js test/voice-sources.test.js test/voice.test.js test/generate.test.js test/improve.test.js test/config.test.js test/detect.test.js` → exit 0
- [ ] `cd apps/events && php artisan test --filter=FeedbackExportTest` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" apps/events/seo/voice/corpus.jsonl` → keine Treffer (nach einem `seo voice` gegen echte Quellen)
- [ ] `git status` in jedem Repo: nur Dateien aus Affected Files

## STOP Conditions
- SerpAPI liefert für Play oder App Store keine Reviews mit Datum: melden.
- Der Fix bräuchte eine Datei außerhalb von Affected Files.

## Maintenance Notes
- Einmalige Einrichtung (README): Token in events `.env` (`FEEDBACK_WIDGET_EXPORT_TOKEN`), derselbe Wert als Secret `VOICE_FEEDBACK_TOKEN` im events-Repo.
- Todo außerhalb des Plans: Datenschutzerklärung events und zeit um die Verarbeitung bereinigter Feedback-Texte durch Anthropic ergänzen.
- zeit hat kein feedback-widget. Wird es dort eingebaut, reicht ein Config-Eintrag.

## Open Questions
- Annahme: SerpAPI liefert Reviews mit Datum und neueste zuerst. Wird in Step 0 geprüft.

## Delegate spec
Folgt nach der Challenge-Runde.
