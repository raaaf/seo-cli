# Etappe D: Seitenvertrag, Shop-Ausgabe und Startmodus für punktundpause.de

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise. The Appendix is binding detail for the steps.
>
> **Drift check (first):** seo-cli `git diff --stat 1346db2..HEAD -- src/ test/ .github/`; shop `git -C /Users/rafael/Developer/kunden/alex/shop diff --stat 20cfca4..HEAD -- app/ routes/ resources/views/ tests/ config/ bootstrap/`. Both empty apart from this plan's changes.

## Meta
- Planned at: seo-cli `1346db2`, shop (raaaf/shop-alex) `20cfca4`, 2026-10-07. seo-cli branch `feature/etappe-d-shop`, worktree `apps/seo-cli-d`; shop branch `feature/seo-landing-pages`.
- Teil von `docs/plans/2026-10-06-system-architecture.md`, Etappe D, plus Startmodus (Etappe H), weil der Shop ohne ihn nichts bekommt.
- Nutzerentscheidungen 2026-10-07: Themenseiten **und** Produkt-/Kategorie-Overlays, beides voll automatisch (auch Overlay-Improve jetzt); Ausgabe als PR mit Markdown im Shop-Repo; Freigabe durch Rafael per PR; nach dem Merge Mail mit Deploy-Hinweis, kein Auto-Deploy; `not_deployed` jetzt, nur Shop; Wochenlauf erzeugt sofort Seiten.
- GSC: Property `https://punktundpause.de/` verifiziert, Inhaber ist das Google-Konto, mit dem seo-cli arbeitet (OAuth, wie zeit). Sitemap am 2026-10-07 eingereicht.
- Challengers: Architecture, Risk (immer), Product (neue Funktion), Design (Themenseite ist UI). Simplicity übersprungen (Umfang vom Nutzer entschieden). Drift check: Orchestrator, keine Abweichung.
- Unabhängig von PR #83 und #84; Überschneidung nur in `CLAUDE.md`, `README.md`, `src/lib/config.js`, `src/steps/watch.js`. Merge nach #84.
- Status: Spec

## Problem
1. seo-cli kann nur Markdown-Landingpages für Dienstleistungsseiten. Der Shop hat Produkte in der Datenbank (Printify-Sync überschreibt `title` bei jedem Lauf, `app/Services/Printify/PrintifySyncService.php:226`) und keine Seitenart für Suchanfragen.
2. Ohne GSC-Historie (Google kannte bis heute 3 von 33 URLs) findet `discover` keine Nachfrage; `greenfield` kennt das Sortiment nicht.
3. seo-cli sieht die Produkte nicht und kann deshalb weder richtig verlinken noch Fakten prüfen.

## Goal
- Der Shop rendert Themenseiten aus `content/landing/de/<slug>.md` unter `/<slug>`, liest Overlays für Produkte und Kategorien und liefert `/seo/catalog.json`.
- seo-cli erzeugt Themenseiten und Overlays nach einem projektspezifischen **Seitenvertrag**, prüft Produktverweise und Fakten gegen den Katalog, und das Gate erzwingt beides.
- Ohne die neuen Konfigurationsschlüssel verhält sich seo-cli bitgleich wie heute.

## Success Metrics
- Bis 2026-11-04: mindestens 50 % der Sitemap-URLs indexiert (`seo/index-status.json` im Shop).
- Bis 2026-11-18: Impressionen größer 0 auf mindestens einer Themenseite (GSC).
- 2026-12-02: einmal prüfen, ob Bestellungen über Themenseiten kamen (Referrer im Analytics). Ohne Signal: Seitentyp überdenken, bevor weitere Seiten entstehen.

## Non-Goals
- Kein Import-Endpunkt in `pages`, kein Filament-Editor, kein Auto-Deploy, keine Mehrsprachigkeit, keine Bilderzeugung.

## Out of Scope (Files)
- Shop: `app/Services/Printify/*`, Checkout, Webhooks, Filament-Ressourcen.
- seo-cli: `src/lib/claude*.js`, `src/lib/budget.js`, `src/steps/counterpart*.js`, `evaluateWatch`-Regeln außer dem einen neuen Eingang.

## Solution

### Approach
Der Seitenvertrag ist das heutige Landing-Format plus projektspezifische Regeln, damit `generate`, `pr`, Gate und `measure` weiter passen und der Shop dasselbe Format rendert wie rafaelalex.de. Neu sind drei Bausteine: der **Katalog** als Faktenquelle, das **Overlay** als zweite Ausgabeart und der **Vertrag** als Konfiguration, die `validate`, `check`, Prompts und Gate gemeinsam lesen. Der Shop schützt sich selbst: Route nur für vorhandene Slugs, Markdown ohne HTML und unsichere Links, Fakten nur aus dem Katalog.

Warum nicht das bestehende `Page`-Modell: es kennt nur feste Slugs (`app/Support/PageRoutes.php:14`, `PageRoutes::ALL`), ist im Admin nur bearbeitbar (kein Anlegen), und seine Inhalte kommen über Seeder und Migrationen. Markdown im Repo behält Git-Review, das seo-cli-Format und die Messung; `Page` bleibt für die festen Seiten zuständig, die Sitemap führt beide Quellen (`SitemapController.php:23`).

Details pro Baustein stehen im Appendix (A Shop, B seo-cli, C Konfiguration).

### Steps
**Teil 1, Shop** (`kunden/alex/shop`, Branch `feature/seo-landing-pages`, Tests mit `./vendor/bin/pest <file>`):
1. `composer require symfony/yaml`; `LandingRepository` (Pfad aus `config/seo.php`), Route, Controller, View, Fixtures. → verify: `./vendor/bin/pest tests/Feature/Seo/LandingPageTest.php` (Appendix A.6 Fälle 1 bis 7)
2. Overlays für Produkt und Kategorie. → verify: `./vendor/bin/pest tests/Feature/Seo/OverlayTest.php`
3. Sitemap, Katalog, Cache-Header. → verify: `./vendor/bin/pest tests/Feature/Seo/SitemapLandingTest.php tests/Feature/Seo/CatalogTest.php`
4. (Orchestrator) `deploy shop test` grün, Audit, Merge, Deploy.

**Teil 2, seo-cli** (Worktree `apps/seo-cli-d`, Tests mit `npx vitest run <files>`):
5. Konfiguration (`page_contract`, `reserved_slugs`, `catalog_url`, `overlays`, `watch.check_deploy`). → verify: `test/config.test.js`
6. `src/lib/catalog.js`; `validate` mit Vertrag (Wortspanne, Pflicht- und verbotene Felder, Produkte, Überschneidung, Kleinschreibung, Fakten-Sperrliste, Titellänge). → verify: `test/catalog.test.js test/validate.test.js`
7. Prompts und `discover` (Katalog-Block, Themen aus den Design-Sprüchen, `reserved_slugs`). → verify: `test/discover.test.js test/generate.test.js`
8. Overlays: `selectOverlayPage`, `overlay.md`, `validateOverlay`, Startmodus-Overlays, Schlüssel `product:`/`category:` in `improvements.json` und `changes.json`, `urlToSlug` für Overlay-URLs. → verify: `test/overlay.test.js test/improve.test.js test/measure.test.js`
9. `seo check` lädt die Konfiguration, leitet Overlay-Pfade an `validateOverlay`, gibt Vertrag und Katalog an `validate`, bricht bei fehlendem Katalog ab. → verify: `test/check.test.js`
9b. `seo-reusable.yml`: neuer Input `op_vault` (Standard `development`, damit events und zeit unverändert laufen); der 1Password-Schritt lädt alle sechs Felder aus `op://<op_vault>/seo-cli/<FELD>`; ein gesetztes Repo-Secret gewinnt; `GSC_CREDENTIALS` und `GSC_TOKEN` sind nicht mehr `required`, der Schritt bricht mit klarer Meldung ab, wenn keine Quelle sie liefert. → verify: `actionlint .github/workflows/seo-reusable.yml` (falls installiert), sonst Review; Testlauf im Shop in Teil 3.
10. `not_deployed` (opt-in). → verify: `test/watch.test.js test/watch-step.test.js`
11. Doku `CLAUDE.md`, `README.md`. → verify: `grep -n "page_contract\|overlay\|catalog" CLAUDE.md README.md`

**Teil 3, Onboarding** (Orchestrator, nach Merge von Teil 1 und 2). Danach events, zeit und portfolio-2025 auf `op_vault: Bots` umstellen, je mit einem `mode=watch`-Lauf als Test, und ihre einzelnen Repo-Secrets löschen, sobald der Lauf grün ist (eigener Schritt, fragt vorher):
12. `seo.config.yaml`, `docs/seo-style.md`, `.github/workflows/seo.yml` (mit `op_vault: Bots`), n8n-Trigger, `submit-sitemap` und `indexnow`. → verify: lokal `seo run --dry-run` im Shop zeigt Katalog geladen und einen Kandidaten mit mindestens 3 `products`; erster `mode=watch`-Lauf grün mit Diagnose aus #84.

### Affected Files
- Shop neu: `config/seo.php`, `app/Support/Landing/LandingRepository.php`, `app/Http/Controllers/LandingController.php`, `app/Support/Seo/Overlay.php`, `app/Http/Controllers/SeoCatalogController.php`, `resources/views/landing/show.blade.php`, `tests/Feature/Seo/*.php`, `tests/fixtures/landing/*.md`, `tests/fixtures/seo/**/*.md`, `content/landing/de/.gitkeep`, `content/seo/products/.gitkeep`, `content/seo/categories/.gitkeep`
- Shop geändert: `composer.json`, `composer.lock`, `routes/web.php`, `app/Http/Controllers/ShopController.php`, `resources/views/shop/show.blade.php`, `resources/views/shop/index.blade.php`, `app/Http/Controllers/SitemapController.php`, `app/Http/Middleware/PublicPageCacheHeaders.php` (Routenliste), `CLAUDE.md`
- seo-cli neu: `src/lib/catalog.js`, `src/prompts/overlay.md`, `src/steps/overlay.js`, `test/catalog.test.js`, `test/overlay.test.js`
- seo-cli geändert: `.github/workflows/seo-reusable.yml`, `src/lib/config.js`, `src/steps/validate.js`, `src/steps/discover.js`, `src/steps/generate.js`, `src/prompts/generate.md`, `src/prompts/greenfield.md`, `src/steps/improve.js`, `src/commands/improve.js`, `src/commands/run.js`, `src/commands/check.js`, `src/lib/measure.js`, `src/lib/improvements.js`, `src/steps/watch.js`, `src/lib/watch.js`, passende Tests, `CLAUDE.md`, `README.md`
- Onboarding (Shop): `seo.config.yaml`, `docs/seo-style.md`, `.github/workflows/seo.yml`

### Conventions
- Shop: Shop-`CLAUDE.md` (Marke klein, keine Gedankenstriche, Pest, TDD bei Bugs); Layout `resources/views/components/layouts/app.blade.php`; JSON-LD wie `App\Support\BreadcrumbJsonLd`; FAQ-Markup wie `resources/views/faq.blade.php:36-50`; Raster wie `resources/views/shop/index.blade.php:79`; Produktabfrage `Product::available()` (`app/Models/Product.php:232`), Sortierung wie `ShopController.php:32`.
- seo-cli: Untrusted-Daten in `<<<UNTRUSTED_*>>>` über `fillTemplate`; Abrufe über `safeFetch` mit Timeout; ohne neue Schlüssel bitgleich.

## Edge Cases
- Produkt wird deaktiviert: Raster lässt es aus; leeres Raster wird samt Überschrift ausgeblendet, der Abschluss-CTA bleibt.
- Neue Route im Shop mit einem Themen-Slug: der Test in A.6 vergleicht `Route::getRoutes()` mit `reserved_slugs`; die Landing-Route trifft nur vorhandene Dateien.
- Katalog nicht erreichbar (Wartungsmodus beim Deploy, `deployment/deploy.sh:135`): `run` überspringt Generate und Overlays mit Warnung, `seo check` schlägt fehl.
- Secrets (Nutzerentscheidung 2026-10-07: zentral in 1Password, Vault `Bots`): Eintrag `Bots/seo-cli` angelegt mit `ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `GSC_CREDENTIALS`, `GSC_TOKEN`, `SEO_NOTIFY_WEBHOOK`; `CLAUDE_CODE_OAUTH_TOKEN` trägt Rafael nach. Der Shop braucht dann nur `OP_SERVICE_ACCOUNT_TOKEN` (vorhanden). Kann dessen Dienstkonto `Bots` nicht lesen, schlägt der Lade-Schritt fehl: dann Rafael das Konto um `Bots` erweitern lassen.

## Known Costs
- Overlay-Improve wird jetzt gebaut, läuft aber erst, wenn GSC Impressionen auf `/shop/`-Seiten zeigt (Nutzerentscheidung gegen „Automatik später“).
- `not_deployed` jetzt statt erst nach einem vergessenen Deploy.
- Zwei Repos in einem Plan; Merge-Reihenfolge Shop, dann seo-cli, dann Onboarding.

## Done Criteria
- [ ] Shop: `./vendor/bin/pest tests/Feature/Seo` grün; `deploy shop test` grün
- [ ] seo-cli: `npx vitest run test/config.test.js test/catalog.test.js test/validate.test.js test/discover.test.js test/generate.test.js test/overlay.test.js test/improve.test.js test/measure.test.js test/check.test.js test/watch.test.js test/watch-step.test.js` → exit 0; `npm run lint` → exit 0
- [ ] Bestehende Tests in beiden Repos nur ergänzt, nicht geändert; `tests/Feature/Seo/SeoTest.php` im Shop bleibt unverändert und grün
- [ ] `git status` in beiden Repos: nur Affected Files

## STOP Conditions
- Ein bestehender Test müsste inhaltlich geändert werden.
- `product-card.blade.php` lässt sich nicht ohne Änderung wiederverwenden.
- Die Landing-Route lässt sich nicht so beschränken, dass `/admin`, `/up`, `/livewire/*` unberührt bleiben.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Maintenance Notes
- `reserved_slugs` mit jeder neuen Shop-Route pflegen (Test schlägt sonst fehl).
- Erhöhung von `max_new_pages_per_month` im Shop erst nach den Success Metrics.

## Challenge Result
Konsolidierung: 27 Punkte → 17 nach Entdoppelung. Konvergent: Route verdeckt Systemrouten (Risk + Architecture), Doorway-Risiko und Seitenmenge (Risk + Product), `not_deployed` als Pflicht für alle (Risk + Architecture + Product), Textlänge vor Produkten (Design + Product).
- **Übernommen:** Route nur für vorhandene Slugs statt Sammelroute, Test für `/admin`, `/up`, kein Session-Cookie bei unbekanntem Slug (A.1).
- **Übernommen:** Fakten-Sperrliste, Material und Größen im Katalog (B.3, A.4).
- **Übernommen:** 2 Seiten pro Monat, mindestens 3 Produkte, höchstens 60 % Überschneidung (C, B.3).
- **Übernommen:** `Product::available()`, Sortierung, `noindex`-Header am Katalog (A.4).
- **Übernommen:** `allow_unsafe_links=false`, Route in die Cache-Header-Liste, Cache-Schlüssel mit Datei-mtime (A.1).
- **Übernommen:** `not_deployed` opt-in, eine Meldung pro Seite, Overlays per Titelvergleich (B.6).
- **Übernommen:** `seo check` lädt Konfiguration, Overlays, Katalog, bricht ohne Katalog ab (B.5).
- **Übernommen:** `steps`/`checklist` verboten, `related_pages` gerendert (B.3, A.2).
- **Übernommen:** Overlay-Schlüssel mit Namensraum, eigene Auswahl, Messung (B.4).
- **Übernommen:** Kategorie-Overlay in `shop/index.blade.php`, im Controller aufgelöst; Einleitung unter dem Raster bzw. als erster Absatz der Beschreibung (A.3).
- **Übernommen:** Fixture-Pfad konfigurierbar, `reserved_slugs` gegen `Route::getRoutes()`, `up` ergänzt (A.6, C).
- **Übernommen:** 300 bis 600 Wörter, Reihenfolge Hero, tldr, Raster, Body, FAQ, CTA; eine h1; Breiten; `eager` und Eager Loading; Kleinschreibung geprüft; `meta_title` um den Markenzusatz kürzer; Abschluss-CTA (A.2, B.3).
- **Übernommen:** Success Metrics, `submit-sitemap` und `indexnow` im Onboarding, Indexierungsdiagnose über #84.
- **Übernommen:** Themen aus den Design-Sprüchen ableiten (B.2).
- **Nutzerentscheidung:** Overlay-Improve jetzt voll (Product schlug „später“ vor), `not_deployed` jetzt nur Shop, Wochenlauf sofort mit Seiten.
- **Erledigt vor dem Plan:** GSC-Zugang (Risk 7).
- **Übernommen (Evaluation):** Begründung gegen `Page`-Wiederverwendung, `SitemapCache`-Schlüssel, Katalog-Schema, verwaiste Overlays, `/shop`-Zeilen aus `discover` raus, Sperrlisten-Regex, Startmodus-Auslöser, `liveChecks`-Form, Overlays mit Sonnet und außerhalb der Monatsgrenze, `SeoTest.php` unverändert.

## Delegate spec

## Task: Etappe D, Teil 1 (Shop) und Teil 2 (seo-cli)
**Goal:** Shop rendert Themenseiten und Overlays aus Markdown und liefert einen Katalog; seo-cli erzeugt nach Seitenvertrag und Katalog passende Dateien, das Gate erzwingt den Vertrag; alle Done Criteria grün.
**Context:** Appendix A (Shop), B (seo-cli), C (Shop-Konfiguration); Aufrufstellen `resources/views/shop/show.blade.php:117-125,316-318`, `resources/views/shop/index.blade.php:7,26,79`, `src/steps/validate.js:98,150-155`, `src/commands/check.js:49`, `src/steps/improve.js:148-161`, `src/lib/measure.js:49-66`, `src/steps/discover.js:120`.
**Affected files:** Abschnitt Affected Files, ohne Onboarding.
**Out of Scope:** Abschnitt Out of Scope; Teil 3 macht der Orchestrator.
**Steps:** Teil 1 (Steps 1 bis 3) und Teil 2 (Steps 5 bis 11) als getrennte Executor-Läufe, je mit ihrem verify.
**Done criteria (all):** Abschnitt Done Criteria.
**STOP conditions:** Abschnitt STOP Conditions.

## Appendix

### A. Shop
**A.1 Route und Repository.** `config/seo.php` mit `landing_path` (Standard `content/landing/de`) und `overlay_path` (`content/seo`), in Tests auf `tests/fixtures/...` umgestellt. `LandingRepository::slugs()` liest die Dateinamen; `routes/web.php` registriert `Route::get('/{landing}', ...)->where('landing', implode('|', slugs))->name('landing.show')`, nur wenn Slugs existieren. Damit trifft die Route keine unbekannten Pfade, startet keine Session für Bot-Anfragen und kann `/admin`, `/up` (`bootstrap/app.php:17`), `/livewire/*` nicht verdecken. `deploy.sh:179` baut den Route-Cache nach dem Pull neu. Frontmatter mit `Symfony\Component\Yaml\Yaml`, Body mit `Str::markdown` und `html_input: escape`, `allow_unsafe_links: false`. Cache pro Datei mit mtime im Schlüssel. Route `landing.show` in die Liste von `PublicPageCacheHeaders`.

**A.2 View.** Reihenfolge: Hero (einzige h1, Größe `--text-h1`), tldr als umrandeter `ink-50`-Block, Produktraster (Klassen wie `shop/index.blade.php:79`, `product-card` mit `eager` für die ersten 3, Varianten und Bewertungszahl eager geladen, nur `Product::available()`, Reihenfolge wie in `products:`), Body (`max-w-prose`, `.prose-page`), `related_pages` als Linkliste, FAQ (Markup wie `faq.blade.php:36-50`), `x-cta` „alle designs ansehen“ nach `/shop`. Leeres Raster samt Überschrift ausblenden. JSON-LD FAQPage und BreadcrumbList.

**A.3 Overlays.** `Overlay::for('products', $slug)` und `Overlay::for('categories', $key)`, Felder `meta_title`, `meta_description`, `intro`. Produkt: im Controller auflösen, `meta_title`/`meta_description` vor `$seoTitle`/`$metaDescription` (`show.blade.php:117-125`), `intro` als erster Absatz im Block „beschreibung“ (`show.blade.php:316-318`), keine neue Überschrift. Kategorie: im `ShopController` auflösen und an `shop/index.blade.php:7,26` übergeben, `intro` (höchstens 60 Wörter) unter dem Raster. Ein Overlay ohne verfügbares Produkt oder ohne Kategorie wird ignoriert und im Admin-Alert-Kanal (`AdminAlert::send`, Schlüssel `seo-overlay-orphan-<slug>`) einmal gemeldet; `seo check` meldet es ebenfalls (B.5), weil der Printify-Sync Slugs ändern kann (`PrintifySyncService.php:220`).

**A.4 Katalog.** `GET /seo/catalog.json`, `Product::available()`, Sortierung wie `ShopController.php:32`, Header `X-Robots-Tag: noindex`, Cache 1 h. Schema: `{ version: 1, generated_at, shipping: { cents, delivery }, categories: [{ key, label, url }], products: [{ slug, title, category, url, description, material, sizes: string[] }] }`, alle Strings, `description` höchstens 300 Zeichen. Felder pro Produkt: `slug`, `title` (`display_title`), `category`, `url`, `description` (gekürzt), `material` und `sizes` aus `config/product_blanks.php`; dazu `categories` mit Label und die festen Fakten `shipping` (`config/shop.php:17` `shipping_cents`, Lieferzeit aus dem Shop-`CLAUDE.md`, heute 5 bis 10 Werktage).

**A.5 Sitemap.** Themenseiten mit `updated` als `lastmod`, Priorität 0.6. `SitemapCache` (`SitemapController.php:17`, 1 h) bekommt die mtime-Summe der Landing- und Overlay-Dateien in den Schlüssel, damit ein Deploy neue Seiten sofort zeigt.

**A.6 Tests.** (1) Jede Fixture rendert 200 mit Canonical und JSON-LD. (2) `/admin`, `/up` und ein unbekannter Slug erreichen den LandingController nicht; unbekannter Slug setzt kein Session-Cookie. (3) HTML im Body wird escaped, `[x](javascript:...)` wird kein Link. (4) Fehlendes oder deaktiviertes Produkt bricht nicht, leeres Raster ist ausgeblendet. (5) Reihenfolge Hero, tldr, Raster, Body, FAQ, CTA. (6) `reserved_slugs` aus `seo.config.yaml` deckt alle einsegmentigen Pfade aus `Route::getRoutes()` ab. (7) Cache greift nach Dateiänderung neu. Overlay-, Sitemap- und Katalog-Tests je ein Fall pro Regel aus A.3 bis A.5.

### B. seo-cli
**B.1 Katalog.** `loadCatalog(config)` über `safeFetch` mit 10 s Timeout, Formprüfung gegen das Schema aus A.4 (`version: 1` Pflicht), einmal pro Prozess (der 1-h-Cache des Shops wird beim Deploy geleert). Fehlt `catalog_url`, ist der Katalog `null` und alles bleibt wie heute.

**B.2 Prompts.** `generate.md` und `greenfield.md` bekommen `{{catalog}}` und `{{contract}}` (beide leer ohne Konfiguration) in UNTRUSTED-Blöcken. Mit Katalog: Themen aus Spruch und Bedeutung der Designs ableiten, Anlass und Raum nur, wenn mehrere Designs dazu passen; `products:` nur aus dem Katalog; Fakten nur aus dem Katalog; keine `steps`/`checklist`.

**B.3 Vertrag in `validate`.** `validate(markdown, keyword, { counterpart, contract, catalog, existingPages })`: `body_words` statt `validate.js:150-151`; `require`/`forbid` Felder; `products` Anzahl und Existenz; Überschneidung der Produktmenge mit jeder bestehenden Seite höchstens `products.max_overlap`; `lowercase: true` prüft Hero, tldr, Überschriften, FAQ, Meta; `meta_title_suffix` (Länge des Markenzusatzes) wird vom Höchstwert abgezogen; `facts_denylist` (Regex) schlägt fehl, außer der Treffer steht wörtlich im Katalog. Ohne `contract` bitgleich.

**B.4 Overlays.** `selectOverlayPage` (eigene Funktion, nicht `selectPage`) wählt `/shop/<slug>` und `/shop?category=<key>` aus GSC-Zeilen, Schlüssel `product:<slug>`/`category:<key>` in `improvements.json` (Cooldown 56 Tage) und `changes.json`; `urlToSlug` (`measure.js:49-66`) gibt für Overlay-URLs diese Schlüssel zurück, damit Messung und Revert-Kandidaten auch für Overlays gelten. Prompt `overlay.md`, `validateOverlay` (Längen, Kleinschreibung, Sperrliste, `intro` 40 bis 120 Wörter, Kategorie höchstens 60). Startmodus: solange keine `/shop/`-Zeilen in GSC stehen, erzeugt `run` pro Lauf höchstens ein Overlay für ein Produkt ohne Overlay (Katalog-Reihenfolge). PR auf `seo/improve/<schlüssel>`. Startmodus heißt: die GSC-Abfrage der letzten 28 Tage liefert keine Zeile mit `/shop/` im Pfad. Overlays nutzen `MODELS.default` mit `batch_generation`, nicht Opus. Overlays zählen nicht gegen `max_new_pages_per_month` (keine neue URL), sind aber auf eines pro Lauf begrenzt. Aufruf in `src/commands/run.js` auf dem bestehenden Improve-Pfad: zuerst Rewrite einer Themenseite, sonst Overlay. `discover` verwirft GSC-Zeilen, deren URL unter `/shop` liegt (`discover.js:92-95`), damit Produktseiten keine Themen-Kandidaten erzeugen.

**B.5 Gate.** `seo check` lädt `seo.config.yaml`, erkennt Overlay-Pfade über `overlays.*`, ruft `validateOverlay` bzw. `validate` mit Vertrag und Katalog; Katalog nicht erreichbar bei gesetzter `catalog_url` → Exit 1 mit Meldung.

**B.6 `not_deployed`.** Nur mit `watch.check_deploy: true`. Für gemergte Seiten und Overlays der letzten 14 Tage, älter als 24 h: Themenseite per HEAD (404 an zwei Tagen in Folge öffnet `not_deployed:<schlüssel>`), Overlay per GET und Vergleich von `<title>` mit `meta_title`. Mail nur beim Öffnen, Schließen bei Erfolg. `evaluateWatch` bekommt einen Eingang `liveChecks: [{ key, url, ok: boolean }]` (null, wenn nicht aktiviert); gleiche Hysterese-Logik wie `traffic_pending` (zwei Tage, Feld `deploy_pending` pro Schlüssel).

### C. Shop-Konfiguration (Onboarding)
`gsc_property: https://punktundpause.de/`, `base_url`, `landing_path: content/landing/de`, `require_review: true`, `greenfield: true`, `max_new_pages_per_month: 2`, `quality: strict`, `catalog_url: https://punktundpause.de/seo/catalog.json`, `style_doc: docs/seo-style.md`, `page_contract: { body_words: [300, 600], require: [products], forbid: [steps, checklist], products: { min: 3, max: 8, max_overlap: 0.6 }, lowercase: true, meta_title_suffix: " . punkt und pause", facts_denylist: ['\\d+([,.]\\d+)?\\s*(€|eur|euro)', '\\d+\\s*(bis|-)?\\s*\\d*\\s*(werktage|tage|wochen)', '(bio|organic|recycel\\w*|nachhaltig\\w*|fair\\s?trade|vegan|klimaneutral)', '\\d+\\s*%\\s*baumwolle'] }`, `reserved_slugs` (alle einsegmentigen Shop-Pfade inkl. `up`, `admin`, `livewire`, `seo`), `overlays: { products: content/seo/products, categories: content/seo/categories }`, `watch: { check_deploy: true }`. n8n: Donnerstag 30 min nach zeit, Wächter täglich.
