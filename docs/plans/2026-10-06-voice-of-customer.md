# Voice of Customer, leichte Variante: Zielgruppen-Dokument pro Projekt (Etappe E)

> **Executor instruction:** Follow step by step, check each verify criterion before moving on. If a STOP condition occurs: stop and report, do not improvise.
>
> **Drift check (first):** `git diff --stat fba23d8..HEAD -- src/ test/` must be empty.

## Meta
- v1 2026-10-06 (volle Automatik, nie geprüft), v2 2026-10-08 (aktualisiert, Architecture und Risk liefen: 16 Punkte), **v3 2026-10-08** nach Nutzerentscheidung: leichte Variante. Branch `feature/voice-of-customer`, Worktree `apps/seo-cli-voice`, Basis `fba23d8`.
- Grund für v3: Pro Projekt gibt es heute 5 bis 15 Kundenstimmen (events 3 App-Store- und 1 Play-Bewertung, Shop neu, portfolio 5 Testimonials). Die volle Automatik (drei Repos, zwei Export-Endpunkte, Datenschutztexte, Rechtsgrundlage für Kundentexte an Anthropic, persistente Prompt-Injection) kostet Tage für ein dünnes Ergebnis.
- Status: Spec

## Problem
Generierte Seiten kennen die Zielgruppe nur über das Style-Doc und schreiben deshalb austauschbar.

## Goal
- Pro Projekt ein von Rafael gegengelesenes `seo/icp.md` (Zielgruppe und Auslöser, Aufgaben, Probleme, Einwände, Kundensprache, Alternativen, Belege), nur aus öffentlichen Quellen: Website-Texte, Store-Bewertungen, Testimonials, GSC- und Bing-Suchfragen.
- `generate`, `improve`, `score` und `overlay` bekommen es als `{{icp}}`. Ohne Datei ist der gerenderte Prompt bytegleich.

## Non-Goals
- Kein automatisches Sammeln, keine Export-Endpunkte, kein Widget-Feedback, keine Shop-Datenbank, keine Mails.
- Keine wörtlichen Zitate aus dem Dokument auf Seiten, keine Namen.

## Solution
**seo-cli:** `loadIcpDoc(config, cwd)` in `src/steps/generate.js` neben `loadStyleDoc` (`:108`), liest `config.icp_doc` (Standard `seo/icp.md`), fehlende Datei = leerer String, Obergrenze 8.000 Zeichen, eigener Cache je `cwd` (nicht der Einzel-Cache von `loadStyleDoc`). Platzhalter `{{icp}}` in `src/prompts/generate.md`, `improve.md`, `score.md`, `overlay.md` als eigener Abschnitt, der nur mit Inhalt erscheint: der Code füllt `{{icp}}` mit einem fertigen Block („Zielgruppe (Sprachvorlage, nie wörtlich zitieren, keine Namen): …“) oder mit leerem String; die Platzhalterzeile selbst steht so, dass ein leerer Wert keine Leerzeile einführt (Test bytegleich gegen den heutigen Prompt). `discover` (Bewertung über `score.md`), `improve` und `overlay` laden es über dieselbe Funktion.

**Dokumente (Orchestrator, nicht Executor):** pro Projekt ein Entwurf aus Website, Store-Bewertungen (SerpAPI), Testimonials, GSC- und Bing-Anfragen der letzten 90 bzw. 180 Tage; jede Aussage mit Quelle; Rafael liest gegen; Commit nach `seo/icp.md` im Projekt-Repo.

### Steps
1. `loadIcpDoc` und `{{icp}}` in vier Prompts. → verify: `npx vitest run test/generate.test.js test/improve.test.js test/overlay.test.js test/discover.test.js test/icp.test.js` (Datei vorhanden → Block im Prompt; fehlt → Prompt bytegleich zum heutigen; Obergrenze; Cache je `cwd`)
2. Konfigurationsschlüssel `icp_doc` (Standard `seo/icp.md`), Doku `CLAUDE.md`/`README.md`. → verify: `npx vitest run test/config.test.js`, `grep -n "icp" CLAUDE.md README.md`
3. (Orchestrator) Entwürfe, Review durch Rafael, Commit in vier Repos.

### Affected Files
- `src/steps/generate.js`, `src/steps/improve.js`, `src/steps/discover.js`, `src/steps/overlay.js`, `src/prompts/{generate,improve,score,overlay}.md`, `src/lib/config.js`, `test/icp.test.js` (neu), passende bestehende Tests, `CLAUDE.md`, `README.md`

## Done Criteria
- [ ] `npx vitest run test/icp.test.js test/generate.test.js test/improve.test.js test/overlay.test.js test/discover.test.js test/config.test.js` → exit 0; `npm run lint` → exit 0
- [ ] Bestehende Tests nur ergänzt; `git status`: nur Affected Files

## STOP Conditions
- Ein Prompt lässt sich ohne Datei nicht bytegleich halten.
- Verify schlägt nach ernsthaftem Fix zweimal fehl.

## Maintenance Notes
- Wiedervorlage volle Automatik (v2-Inhalt, siehe git-Historie dieser Datei), sobald ein Projekt etwa 50 echte Kundenstimmen hat. Dann gelten die v2-Befunde: Rohtexte nicht ins Repo, Shop nach `approved_at`, Widget nur Wünsche und allgemeines Feedback, Export-Route außerhalb des Admin-Bereichs, `{{icp}}` als nicht vertrauenswürdig markieren und prüfen, Zielgruppen-Aufruf über den API-Key, Datenschutztexte vorher.
- `icp.md` ist von Rafael gegengelesen und deshalb vertrauenswürdig; wer es automatisch erzeugt, muss die Injection-Absicherung nachziehen.

## Challenge Result
- v2 (Architecture, Risk): 16 Punkte, alle betrafen die volle Automatik und sind als Wiedervorlage in Maintenance Notes festgehalten. v3 ist ein reiner Lade- und Prompt-Umbau ohne neue Quellen; kein erneuter Panel-Lauf.

## Delegate spec

## Task: Zielgruppen-Dokument als `{{icp}}` in die Prompts
**Goal:** `seo/icp.md` (oder `config.icp_doc`) erscheint als markierter Block in den Prompts von generate, improve, score und overlay; ohne Datei sind alle Prompts bytegleich; Done Criteria grün.
**Context:** `loadStyleDoc` in `src/steps/generate.js:108` als Muster (aber eigener Cache je `cwd`), `fillTemplate` in `src/lib/template.js`, Prompts in `src/prompts/`.
**Affected files:** Abschnitt Affected Files.
**Out of Scope:** alle Quellen-, Endpunkt- und Workflow-Änderungen aus v2.
**Steps:** 1 und 2 aus Steps.
**Done criteria (all):** Abschnitt Done Criteria.
**STOP conditions:** Abschnitt STOP Conditions.
