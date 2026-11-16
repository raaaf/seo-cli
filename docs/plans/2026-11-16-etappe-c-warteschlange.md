# Etappe C: Warteschlange für Aktionen

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat aa044a0..HEAD -- src/commands/run.js src/commands/improve.js src/steps/ src/lib/ src/prompts/ .github/workflows/seo-reusable.yml`
> If an in-scope file has changed since the plan was created: reconcile the current state against the live code; on a mismatch, that is a STOP condition.

## Meta
- Planned at: commit `aa044a0`, 2026-11-16. Baut auf `docs/plans/2026-10-06-system-architecture.md` (Abschnitt 2 "Entscheiden", "Sicher") auf.
- Nutzerentscheidungen 2026-11-16: Queue jetzt bauen, mit `snippet_test` und `refresh`. Auto-Merge nur für kleine Diffs (`snippet_test`, `new_page`, plus `overlay`, weil das nur Metatext ist). Alarme ohne Inhaltsbezug wirken als Sperren und Bremse, nicht als Aktionen.
- Challengers: Architektur und Risiko liefen (Pflicht). Produkt, Design und Einfachheit liefen nicht: Der Umfang ist vom Nutzer entschieden, und es gibt keine UI-Fläche. Drift-Check vom Orchestrator: HEAD = `aa044a0`, sauber.
- Status: Implemented (PR #131, 2026-11-16)

Datenlage der Zielrepos: siehe Appendix.

## Problem
Was ein Lauf tut, entscheidet eine feste `if`-Kette in `src/commands/run.js` (Revert 452-460, Improve-Slots 522-527 und 555-620). Es gibt keine gemeinsame Rangfolge und keine globale PR-Obergrenze. Es fehlt ein `refresh`, und `snippet_test` gibt es nicht als eigenen Typ (der Snippet-Fall schreibt die ganze Seite neu, `src/steps/improve.js:350`). Es gibt weder `paused` noch eine Notbremse. Rewrites und Reverts mergen automatisch: `revert.js:162` und `improve.js:279` öffnen sie nicht als Draft, `src/lib/github.js:22` setzt standardmäßig `draft: false`. Im Architekturplan steht dagegen: "Revert-PRs werden nie automatisch gemergt".

## Ziel
- `seo run` sammelt Kandidaten aus allen Quellen und ordnet sie regelbasiert. Danach greifen Sperren und Bremse, und es werden höchstens `max_prs_per_run` PRs geöffnet.
- `seo/queue.json` und `report.queue` zeigen jeden Kandidaten mit Typ, Quelle, Begründung und Status (`selected`, `opened`, `deferred`, `blocked`, jeweils mit Grund).
- Automatisch gemergt werden nur `snippet_test`, `new_page` und `overlay`. Alles andere wird ein Draft-PR mit dem Block "Warum diese Aktion".
- Jede ausgeführte Aktion speichert `predicted: { type, score, basis }` im Ledger, damit Etappe F daraus lernen kann.

## Non-Goals
- Kein Nutzen-pro-Kosten-Score und kein Playbook. Das gehört zu Etappe F.
- Keine Aktionen für Bing, `ai_crawler_blocked` und `structured_data`. Die bleiben in der Mail.
- Kein `icp_refresh`, `contract_refresh` und keine `template_suggestion`.
- Die Pick-Regeln der bestehenden Picker ändern sich nicht. Sie bekommen nur `skip` und `limit`.

## Out of Scope (Files)
- `src/steps/watch.js`, `src/lib/watch.js`: Der Wächter setzt nur Alarme, die die Queue liest.
- `src/steps/review.js`, `src/steps/verify.js`: Die Prüfungen bleiben unverändert.
- `.github/workflows/seo-reusable.yml`: Alle Zielrepos sind auf `9286bd8` gepinnt. Das Gate hält dort schon Drafts (375-378). Eine Änderung würde die Zielrepos erst nach einem Pin-Bump erreichen.

## Lösung

### Approach
Der Ablauf von `run` bleibt in drei Phasen wie heute: vorbereiten, State committen, veröffentlichen. Generieren läuft weiter als Batch (`pLimit(2)`, `createPRs` mit hreflang über den ganzen Lauf). Neu ist nur die Auswahl:

1. **Revert-Phase bleibt vorn** (`run.js:452`), weil die Cooldown-Einträge danach auf der Platte stehen müssen. Ihre Ergebnisse gehen als bereits ausgeführte Einträge in die Queue. Nur `opened` zählt gegen den Cap. Gibt es mehr Kandidaten als `max_prs_per_run - 1`, werden die übrigen auf den nächsten Lauf verschoben (`deferred: 'cap'`, ohne `revert`-Feld am Ledger-Eintrag).
2. **`collectCandidates`** (`src/steps/queue.js`) holt GSC-Zeilen und Engagement einmal. Danach ruft es jeden Picker mit `limit: 1` und dem `skip` der schon gesammelten Slugs auf. Jeder Kandidat trägt `touches`: Slug, Counterpart, bei Merge das `from`, bei Prune das `into`. Ein GSC-Kandidat trägt das volle `selectPage`-Objekt (Queries, `kind`, `foreignQueries`, Engagement).
3. **`buildQueue`** (`src/lib/queue.js`) ist rein: Rangfolge, Dedup über `touches`, Sperren, Bremse und Cap. Ein Platz ist für `new_page`, `snippet_test` oder `overlay` reserviert, damit die Seitenarbeit nicht verhungert.
4. **Ausführung** läuft der Reihe nach durch die ausgewählten Einträge. Vor jedem Eintrag wird `touches` gegen das laufende `touchedSlugs` geprüft, also gegen die tatsächlich vorbereiteten Dateien inklusive Inbound-Link-Edits. Gibt `prepareImprove` `null` zurück, rückt der nächste `deferred`-Eintrag nach. Der Cap zählt nur, was wirklich geöffnet wurde.

| Typ (Rang) | Quelle | Auto-Merge |
|---|---|---|
| 1 `revert` | `revertCandidates` | nein |
| 2 `merge`, `prune` | `pickMergePage`, `pickPrunePage` (nur ohne `catalogDown`) | nein |
| 3 `refresh` | `pickSeasonPage`, Stale-Erkennung | nein |
| 4 `rewrite` | `pickAssessedPage` (Quelle `alert`); `selectPage` mit `near_page1`/`far` (Quelle `gsc`, nur in Wochen ohne generierte Seite, wie heute 522) | nein |
| 5 `snippet_test` | `selectPage` mit `kind: 'snippet'` und Baseline ≥ 100 Impressionen | ja |
| 6 `overlay` | Pick von `prepareOverlay` (Shop, Rezepte), wie heute nur, wenn keine Landingpage qualifiziert | ja |
| 7 `new_page` | `getPending`, bis `min(weekly_cap, Monatsrest)` | ja |

Innerhalb eines Typs zählt der heutige Score.

### Sperren und Bremse (in `buildQueue`)
- **`paused: true`**: Nur `revert` läuft, alles andere ist `blocked: 'paused'`.
- **Notbremse**: Es gibt einen offenen `traffic_drop`, dessen `since` 7 bis 35 Tage nach dem jüngsten `merged_at` in `changes.json` liegt (kein Merge zwischen jenem Merge und `since`). Dann sind `new_page`, `snippet_test`, `refresh` und GSC-`rewrite` `blocked: 'brake'`. Assessed Rewrites bei offenem `deindexed`/`site_not_indexed` laufen weiter, weil sie die Abhilfe sind. Die Bremse endet mit dem Alarm, spätestens aber 56 Tage nach `since`, dann kommt eine Warnung.
- **`site_not_indexed` offen**: `new_page` ist gesperrt.
- **`not_deployed:<key>` offen**: Alles, was diesen Slug in `touches` hat, ist gesperrt.
- **Recrawl-Sperre** nur für Nachbarn: Eine Seite, die ein Merge- oder Prune-PR der letzten 28 Tage als Ziel getroffen hat, bekommt kein `rewrite` und kein `snippet_test`, bis `index-status.json` einen Crawl nach dem Merge zeigt. Die eigenen Rewrites deckt schon der 56-Tage-Cooldown ab. Saison-Refreshs sind ausgenommen.
- **Offene Drafts**: Ein Slug mit einem offenen PR im improvements-Ledger (`pr_url` ohne `merged_at`) wird nicht erneut gewählt, auch nicht nach Ablauf des Cooldowns. Liegen 3 oder mehr gehaltene Drafts offen, werden neue Nicht-Auto-Typen außer `revert` `deferred: 'drafts_waiting'`.

### Neue Typen
**snippet_test** (`src/steps/snippet.js`, Prompt `src/prompts/snippet.md`, Modell `MODELS.default`) gibt nur `{ meta_title, meta_description }` zurück. Die Felder werden per Textedit ins Frontmatter geschrieben (Stil wie `addRelatedPage`). Der Prompt lässt nur Aussagen zu, die schon im Body stehen. Ein Fehler zählt nur, wenn er neu ist gegenüber `validate(aktuelle Seite)` oder die beiden Felder betrifft. Der Counterpart bleibt unverändert. Branch `seo/snippet/<slug>`, im improvements-Eintrag `snippet: true`. Zwei Fehlschläge setzen einen `failed`-Cooldown.

**refresh** (`src/lib/refresh.js`): Eine Seite ist stale, wenn die **höchste** Jahreszahl in `meta_title`, `meta_description` oder H1 kleiner ist als das aktuelle Jahr. Jahreszahlen nach "seit", "ab" oder "bis" und Spannen wie "2026/27", deren Ende nicht vorbei ist, zählen nicht. Stale ist eine Seite auch, wenn `updated` älter als 365 Tage ist. Ausgeschlossen sind Cooldown, `exclude_slugs` und Seiten mit erfolgreichem Rewrite in den letzten 300 Tagen. Pro Lauf gibt es höchstens einen Stale-Refresh. Er läuft über `prepareImprove({ pick })` mit fester Diagnose und vollem Fact-Check.

### Weitere Änderungen
- `publishImprove`: `draft` kommt aus `prepared.auto`. Ohne Queue (standalone `seo improve`, alte Aufrufer) gilt der Default `auto: true`, damit sich dort nichts ändert. Merge und Prune bleiben Draft. `revert.js:162` öffnet als Draft. `report.prs[].held = true` bei Drafts. Steht der Peak eines Saison-Refresh-Drafts weniger als 14 Tage bevor, sagt die Mail das.
- Failed-Cooldown (`improve.js:272`) gilt auch für `snippet`, `refresh` und GSC-`rewrite`.
- Ledger: `rewriteEntry` setzt `kind: 'snippet'` und `predicted`. `recordImprovement` (`src/lib/improvements.js:29`) übernimmt `snippet` und `queue`. Ebenso `src/lib/measure.js:140` und `revertCandidates` (`revert.js:46`).
- Handmerge: `reconcileState` ruft `submitFixes` einmal auf, aber nur für gemergte PRs, deren improvements-Eintrag `held: true` trägt. Bei `watch.check_deploy` vorher `isLive`.
- Kontroll-Fallback (`src/steps/measure.js`): Gibt es weniger als 12 Landing-Kontrollen, kommen die anderen Site-URLs dazu. Sie stammen aus einer eigenen, ungefilterten Map der GSC-Seitenzeilen (`windowPages` verwirft sie heute). Das Reading bekommt `controls_source: 'site'`. Die Streuungsgrenze ist dann halb so groß wie `MAX_DISPERSION`. Solche Readings setzen nie `revert_candidate`.
- `seo/queue.json` enthält nur stabile Felder (`type`, `slug`, `source`, `status`, `reason`) und keine Scores. Scores stehen in `report.queue`. Die Datei kommt in `STATE_FILES`, nicht in die `files` von watch.

### Steps
1. **Verhaltensmatrix vor dem Umbau.** In `test/run-pipeline.test.js` bekommt jeder heutige Guard einen eigenen Test: GSC-Pick nur ohne generierte Seite, Saison und Assessed auch in Generier-Wochen, Merge und Prune nicht bei `catalogDown`, Assessed-Extra-Slot nur neben einem primären Rewrite, Overlay-Fallback, `touchedSlugs` für Geschwister-PRs. → verify: `npx vitest run test/run-pipeline.test.js` ist grün, auf dem alten Code.
2. `src/lib/queue.js` (`buildQueue`) und `test/queue.test.js` mit je einem Test pro Regel aus "Sperren und Bremse", Rangfolge, Dedup über `touches`, Cap mit reserviertem Platz und Nachrücken. → verify: `npx vitest run test/queue.test.js`.
3. `src/lib/refresh.js` und `test/refresh.test.js`: Fälle "Stand 2025", "seit 2025", "Silvester 2026/27", altes `updated`, 300-Tage-Ausschluss. → verify: `npx vitest run test/refresh.test.js`.
4. Picker bekommen `limit`/`skip`: `pickSeasonPage`, `selectPage` (dort wird `skip` in `cooldown` gemischt), `pickAssessedPage`, `pickMergePage`, `pickPrunePage`. `prepareImprove({ pick })` nimmt das volle Pick-Objekt und wählt nicht intern. Ohne `pick` bleibt alles unverändert. → verify: `npx vitest run test/improve.test.js test/improve-cmd.test.js test/assessed-rewrite.test.js`, plus ein Test, dass `pick` mit GSC-Objekt die Queries in den Prompt bringt.
5. `src/steps/snippet.js`, `src/prompts/snippet.md`, `test/snippet.test.js`. Geprüft wird: Body byte-gleich, alte Body-Fehler blockieren nicht, ein neuer Feldfehler führt zum zweiten Versuch, zwei Fehlschläge ergeben `failed`. → verify: `npx vitest run test/snippet.test.js`.
6. **Eigener Commit vor dem Umbau:** Draft-Logik (`prepared.auto`, Default `true`), Revert als Draft, `held` in `report.prs` und im improvements-Eintrag. Ledger: `kind: 'snippet'`, `predicted`, `recordImprovement`, `measure.js:140`, `revertCandidates`. Failed-Cooldown erweitert. `revertWorseRewrites` (`src/steps/revert.js:97`) bekommt `max`: Es öffnet höchstens so viele, der Rest bleibt ohne `revert`-Feld für den nächsten Lauf. → verify: `npx vitest run test/changes.test.js test/revert.test.js test/measure.test.js test/improve-cmd.test.js`, mit Tests: Rewrite und Revert ergeben `draft: true`, standalone `seo improve` ergibt `draft: false`, `max: 1` bei 2 Kandidaten öffnet einen.
7. `src/steps/queue.js` (`collectCandidates`) und der Umbau von `run.js` zu collect → `buildQueue` → sequenzieller Ausführung mit Laufzeit-`skip`. Dazu kommen `report.queue` und `seo/queue.json`. Die Recrawl-Prüfung nutzt `lastChangeDate`/`isWaiting` aus `assess.js:150-162`, exportiert nach `src/lib/recrawl.js`, damit Queue und Assess eine Definition teilen. **Selbstüberwachung:** Eine Zeile in `report.warnings` (die Mail zeigt Warnungen schon heute) gibt es, wenn Einträge `selected` waren und nichts geöffnet wurde; wenn Bremse oder `paused` greift, mit Tagen seit Beginn; für jeden gehaltenen Draft, der älter als 14 Tage ist. Ein geschlossener Draft fällt schon heute aus `improvements.json` (`run.js:390-393`) und gibt seinen Slug frei. → verify: Die Matrix aus Schritt 1 bleibt unverändert grün. Neu: ein Test, dass bei 2 Reverts, Saison, Assessed-Pick und 2 Keywords mit Cap 4 genau 2 Reverts, 1 Refresh und 1 `new_page` geöffnet werden, und je ein Test pro Warnung.
8. Handmerge-Resubmit mit injiziertem `submit`. → verify: Der Test zeigt einen Aufruf nur für `held`-Einträge und keinen bei Auto-Merges.
9. Kontroll-Fallback, als letzter Schritt und unabhängig von der Queue. → verify: `npx vitest run test/measure-step.test.js`. 8 Landing-Kontrollen plus 10 Site-URLs ergeben ein Verdict mit `controls_source: 'site'`. Ein negatives Paar setzt kein `revert_candidate`.
10. Config-Defaults `max_prs_per_run: 4` und `paused: false`, dazu CLAUDE.md (Pipeline, State Files, revert, snippet, queue). → verify: `npm run lint` exit 0, `grep -c "queue.json" CLAUDE.md` ≥ 1.

### Affected Files
- neu: `src/lib/queue.js`, `src/lib/refresh.js`, `src/steps/queue.js`, `src/steps/snippet.js`, `src/prompts/snippet.md`, `test/queue.test.js`, `test/refresh.test.js`, `test/snippet.test.js`
- `src/commands/run.js` (452-660, `reconcileState`, `rewriteEntry`, `ledgerEntry`), `src/commands/improve.js` (36-120, 262-300)
- `src/steps/improve.js` (`selectPage` 174), `src/lib/seasons.js`, `src/lib/assessed-rewrite.js`, `src/steps/revert.js`, `src/steps/measure.js`, `src/lib/measure.js`, `src/lib/improvements.js`, `src/steps/pr.js`, `src/lib/state.js`, `src/lib/config.js`, `src/lib/keywords.js` (`QUEUE_FILE`)
- Tests: `test/run-pipeline.test.js`, `test/improve*.test.js`, `test/assessed-rewrite.test.js`, `test/revert.test.js`, `test/changes.test.js`, `test/measure*.test.js`
- `CLAUDE.md`

### Conventions
Reine Regeln gehören nach `src/lib/`, I/O nach `src/steps/`. Vorbild ist `src/lib/assessed-rewrite.js`, für den Textedit `addRelatedPage` in `src/lib/inbound-links.js`. Untrusted Queries stehen in `<<<UNTRUSTED_*>>>` und gehen durch `fillTemplate`. Modelle nur über `MODELS`, vor jedem LLM-Aufruf `assertBudget`. State nur über `commitState`. Mocks nur an GitHub-, GSC- und LLM-Grenzen, über injizierbare Parameter.

## Edge Cases
- Bremse aktiv und kein Revert: kein PR, Status `idle`, den Grund zeigt `report.queue`.
- Dry-Run: Die Queue wird gedruckt, `seo/queue.json` wird nicht geschrieben.
- Eine Seite ist gleichzeitig Assessed-Pick und GSC-Pick: Der Assessed-Pick gewinnt.
- Ein Revert wird `superseded` oder `skipped`: zählt nicht gegen den Cap.

## Known Costs
- Rewrites, Refreshs und Reverts warten auf dich, das sind etwa 1 bis 3 Drafts pro Woche und Projekt. Ab 3 offenen Drafts erzeugt der Lauf keine weiteren.
- Saison-Refreshs mergen nicht mehr automatisch, ein Peak kann verpasst werden. Die Mail warnt 14 Tage vorher.
- Bis Mitte Dezember lässt sich die Revert-Rangfolge nur in Tests prüfen.

## Done Criteria
- [ ] `npx vitest run test/queue.test.js test/refresh.test.js test/snippet.test.js test/run-pipeline.test.js test/revert.test.js test/changes.test.js test/measure.test.js test/measure-step.test.js test/improve.test.js test/improve-cmd.test.js test/assessed-rewrite.test.js` → exit 0
- [ ] `npm run lint` → exit 0
- [ ] `node bin/seo.js run --dry-run` in einem events-Worktree druckt `report.queue` mit mindestens einem Eintrag, `git status` dort bleibt sauber
- [ ] `grep -n "pickSeasonPage\|pickAssessedPage\|pickMergePage\|pickPrunePage" src/commands/run.js` → keine Treffer
- [ ] `git status`: nur Dateien aus Affected Files

## STOP Conditions
- Drift an den genannten Stellen.
- Ein Verify scheitert zweimal nach ernsthaftem Fix.
- Die Verhaltensmatrix aus Schritt 1 wird nach dem Umbau rot und lässt sich nicht ohne Regeländerung grün machen.
- Eine Änderung an `seo-reusable.yml` ist nötig.

## Validation of the Bet
- **Funktioniert, wenn:** Bis 2026-12-23 hat jedes der vier Projekte (portfolio, events, zeit, shop) Läufe mit `report.queue` und nie mehr PRs als den Cap, und mindestens ein `snippet_test` ist gemergt und im Ledger `kind: 'snippet'`.
- **Rollback, wenn:** Zwei Läufe in Folge öffnen in einem Projekt nichts, obwohl Einträge `selected` waren. Dann den Umbau-Commit aus Schritt 7 reverten (die Draft-Sicherung aus Schritt 6 bleibt).

## Maintenance Notes
- Etappe F ersetzt nur die Sortierung in `buildQueue`. `predicted` bleibt das Feld für die Kalibrierung.
- Reviewer: Die Verhaltensmatrix ist der Vertrag des Umbaus, Tests dort nicht lockern.

## Challenge Result
Konsolidierung: 24 Einwände wurden zu 17 zusammengeführt. Konvergent waren Bremse, Recrawl-Sperre, Kontroll-Fallback, Cap-Verhungern und die Revert-Phase (je Architektur + Risiko).
- **Accepted:** Bremse nur nach einem jüngsten Merge, Assessed Rewrites ausgenommen, mit Ablauf (A+R). Recrawl-Sperre nur für Nachbarn, Saison ausgenommen (A+R). Fallback: ungefilterte Map, strengere Streuung, kein `revert_candidate` (A+R). Ein reservierter Platz plus Verhaltensmatrix (A+R). Revert-Phase bleibt vorn, Cap nach Ergebnis, Draft im selben Commit (A+R). Snippet: nur neue Fehler zählen, nur Aussagen aus dem Body (R). Offene Drafts sperren den Slug, ab 3 Drafts keine weiteren (R). Refresh nach höchster Jahreszahl, "seit/ab/bis" ausgenommen (R). Resubmit nur für gehaltene PRs, `isLive` vorher (R). `queue.json` ohne Scores (R). `pick` trägt das volle GSC-Objekt (A). Typ `overlay` (A). `touches` plus Laufzeit-`skip` (A). Default `auto: true` außerhalb der Queue (A). Drei Phasen bleiben, generieren bleibt Batch, Nachrücken (A). Picker mit `limit`/`skip` (A). Fehlende Dateien und Failed-Cooldown ergänzt (A).
- **Evaluation (übernommen):** Schritt 6 (Drafts, Ledger, Revert-`max`) als eigener Commit vor dem Umbau; Selbstüberwachung über `report.warnings`; Draft-Alter 14 Tage; Recrawl-Helfer aus `assess.js` geteilt; `revertWorseRewrites` mit `max`; Fallback als letzter Schritt.
- **Evaluation (abgelehnt):** Kontroll-Fallback und `refresh` in Folge-PRs auslagern: Das widerspricht der Nutzerentscheidung "Queue + neue Typen", die beides einschließt. Der Fallback steht jetzt zuletzt und kann einzeln zurückgenommen werden.
- **Rejected:** Saison-Refreshs automatisch mergen (R): Das widerspricht der Nutzerentscheidung "nur kleine Diffs". Stattdessen warnt die Mail 14 Tage vor dem Peak.

## Delegate spec

## Task: Etappe C, regelbasierte Aktions-Warteschlange
**Goal:** `seo run` wählt Aktionen über `collectCandidates` und `buildQueue` statt über die `if`-Kette, schreibt `seo/queue.json` und `report.queue`, begrenzt mit `max_prs_per_run` (Default 4, ein Platz reserviert für Seitenarbeit), hält Nicht-Auto-PRs als Draft und kennt `snippet_test`, `refresh` und `overlay` als Typen.
**Context:** `if`-Kette in `src/commands/run.js:452-460, 522-527, 555-620`, Veröffentlichung 619-652, `touchedSlugs` 43-46. Picker in `src/lib/assessed-rewrite.js:67/105/155`, `src/lib/seasons.js`, `src/steps/improve.js:174`. Revert in `src/steps/revert.js:43/97/162`. Draft in `src/commands/improve.js:279`, das Gate hält Drafts. Recrawl- und Wartelogik in `src/steps/assess.js:150-162`. Kontrollen in `src/lib/measure.js:151` und `src/steps/measure.js:32-43, 86-88`. Vorbilder: `assessed-rewrite.js`, `addRelatedPage`.
**Affected files:** siehe Plan, Abschnitt Affected Files.
**Out of Scope:** `src/steps/watch.js`, `src/lib/watch.js`, `src/steps/review.js`, `src/steps/verify.js`, `.github/workflows/seo-reusable.yml`.
**Steps:** 1 bis 10 aus dem Plan, in dieser Reihenfolge. Schritt 1 (Verhaltensmatrix) muss auf dem alten Code grün sein, bevor Schritt 7 beginnt. Schritt 6 und Schritt 7 sind getrennte Commits.
**Done criteria (all):** siehe Plan, Abschnitt Done Criteria.
**STOP conditions:** Drift. Ein Verify scheitert zweimal. Die Matrix wird rot und lässt sich nicht ohne Regeländerung grün machen. `seo-reusable.yml` müsste geändert werden.

## Appendix: Datenlage (2026-11-16, Default-Branch der Zielrepos)

| Projekt | Ledger | d28 vorhanden | d28 fällig am 19.11. | offene Index-Alarme |
|---|---|---|---|---|
| portfolio-2025 | 11 (7 new, 4 rewrite) | 0 | 5 new, 1 rewrite | 0 |
| events | 10 (4 new, 6 rewrite) | 0 | 2 rewrite | 5 deindexed, `clean`, assessed |
| zeit | 4 rewrite | 0 | 3 rewrite | `site_not_indexed` seit 07.10. |
| shop-alex | 8 (6 new, 2 rewrite) | 0 | 2 new | 0 (ai_crawler, bing) |
| topf-secret, sprachverliebt | keins | | | topf-secret: 11 |

Kein Projekt hat bisher einen Messwert. Der erste `revert_candidate` ist frühestens im Lauf am 17.12. möglich, denn d56 ist erst ab Merge plus 66 Tage fällig. zeit kann mit Landing-Kontrollen allein nie ein Verdict bekommen (`MIN_CONTROLS = 12`, `src/lib/measure.js:12`).
