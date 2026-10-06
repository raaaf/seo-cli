# seo-cli: Systemarchitektur (lernender Kreislauf)

Planned at: seo-cli `860b86d`, 2026-10-06. Status: Spec, Challenge abgeschlossen. Baut auf `2026-10-06-pipeline-roadmap.md` auf und ersetzt deren Roadmap-Reihenfolge.

## Problem
seo-cli ist heute eine lineare Pipeline: `discover → generate → validate → fact-check → pr → track`. Sie handelt, misst aber nicht, ob eine Handlung gewirkt hat, und lernt deshalb nichts. Datenquellen, Seitenschema und Ausgabe sind fest verdrahtet, Wissen über Google und KI-Suche steckt als statischer Text in den Prompts und veraltet. Kosten werden nur teilweise begrenzt (SerpAPI-Kontingent wird in CI nicht gespeichert, siehe unten).

## Ziel
Ein Kreislauf pro Projekt, der jede Woche beobachtet, entscheidet, handelt, misst und lernt. Anforderungen und wie sie geprüft werden:

| Anforderung | Messbar als |
|---|---|
| Flexibel | Neues Projekt ohne Code-Änderung in seo-cli, nur `seo init` |
| Lernend | Jede Änderung hat nach 56 Tagen ein Ergebnis, Regeln mit Belegzahl fließen in Bewertung und Prompts |
| Aktuell | Jede Datenquelle hat ein Ablaufdatum, Wissen über Google/Bing/KI wird monatlich mit Quellen erneuert |
| Schnell | Deindexierung wird innerhalb von 24 h erkannt, ein Ranking-Absturz sobald GSC ihn zeigt (GSC liegt 3 bis 7 Tage zurück) |
| Effizient | Feste Kostengrenze pro Projekt und Monat in USD, Lauf ohne lohnende Aktion kostet fast nichts |
| Effektiv | Gemessen an der Zielgröße des Projekts (Conversions, sonst Klicks), nicht an der Zahl der Seiten |

## Der Kreislauf

```
        ┌──────────────────────────────────────────────────────────┐
        ▼                                                          │
  1 BEOBACHTEN      Signal-Adapter → Signal-Speicher (mit Ablaufdatum) │
        │                                                          │
  2 ENTSCHEIDEN     alle möglichen Aktionen → eine Warteschlange,     │
        │           bewertet nach erwartetem Nutzen / Kosten, Budget  │
  3 HANDELN         Aktion durchläuft Postma-Phasen + Prüfungen → PR  │
        │                                                          │
  4 MESSEN          Änderungsbuch + Ergebnis nach 14/28/56 Tagen      │
        │           gegen Kontrollgruppe                             │
  5 LERNEN          Regeln (Playbook) + Kalibrierung der Bewertung ───┘
```

### 1. Beobachten: Signal-Speicher
- Jede Datenquelle ist ein **Signal-Adapter** mit einheitlicher Schnittstelle: `fetch({ since, config }) → records[]`, dazu `ttl` (wie lange die Daten gelten) und `cost` (Abfragen, USD).
- Ergebnisse landen in `seo/signals/<quelle>.json`, mit Zeitstempel. **Maschinenstand wird am Ende jedes Laufs direkt nach `main` committet** (mit `[skip ci]`), nicht über PRs. PRs enthalten nur noch Seiten. (Ursprünglich ein eigener Branch `seo-state`, geändert in Etappe A.1, weil das Dashboard aus dem `main`-Checkout liest.) Heute wird Stand nur gespeichert, wenn ein PR entsteht (`src/commands/run.js:227`), Läufe ohne PR verlieren alles (auch `validation_failed`-Status). Vorbild ist `index-status --commit` (`src/commands/index-status.js:43-54`). Schreiben ohne `force` (heute `force: true` in `src/lib/github.js:79`), bei Konflikt neu laden und erneut versuchen. Ein Lauf holt nur, was abgelaufen ist, und nur ab dem letzten Stand. SERP-Daten gelten z. B. 30 Tage, GSC 1 Tag, Reviews 7 Tage.
- Adapter laufen parallel. Ein Fehler betrifft nur diese Quelle.
- Bestehende Quellen (GSC, SerpAPI, Index-Status) werden zu Adaptern umgebaut, neue Quellen (Voice, AI Overview, Bing, Rybbit, KI-Zitate) kommen nur noch als Adapter dazu.

### 2. Entscheiden: eine Warteschlange für alle Aktionen
Heute entscheidet `run` hart: erst neue Seiten, wenn keine da sind `improve`. Neu werden alle möglichen Aktionen Kandidaten in einer Warteschlange:

| Aktionstyp | Auslöser |
|---|---|
| `new_page` | Belegte Nachfrage ohne passende Seite |
| `rewrite` | Seite in Reichweite von Seite 1, Relevanzlücke |
| `snippet_test` | Seite auf Seite 1 mit schwacher CTR |
| `refresh` | Fakten veraltet (`updated` alt, Jahreszahlen, Preise) |
| `revert` | Änderung mit negativem Ergebnis |
| `icp_refresh`, `contract_refresh` | Neue Kundenstimmen, Renderer geändert |
| `template_suggestion` | Abschnitt fehlt im Template, viele Seiten bräuchten ihn |

**Reihenfolge in Etappe C regelbasiert:** `revert` > `refresh` > `rewrite` > `snippet_test` > `new_page`, innerhalb eines Typs nach dem heutigen Score. Jeder Kandidat speichert trotzdem seine Nutzen-Vorhersage, damit Etappe F kalibrieren kann. Ab Etappe F bekommt jeder Kandidat einen **erwarteten Nutzen** (geschätzter Zuwachs der Zielgröße × Wahrscheinlichkeit aus dem Playbook) und **Kosten** (Tokens, Abfragen). Der Lauf arbeitet die Liste nach Nutzen pro Kosten ab, bis das Budget erschöpft ist oder kein Kandidat mehr über der Schwelle liegt. `weekly_cap` wird zur Obergrenze der PRs, nicht mehr zur Zielmenge. Dazu eine **harte Obergrenze für neue Seiten pro Projekt und Monat** (`max_new_pages_per_month`, Start 4), die das Lernen nicht ändern kann.

**Ein PR pro Aktion:** Branches heißen `seo/<aktion>/<slug>` statt `seo/<woche>` (`src/steps/pr.js:13`), das Gate prüft eine Liste offener PRs statt einer einzelnen `seo/last-pr.json`. Heute schreibt nur der Weg über neue Seiten `last-pr.json` (`src/commands/run.js:232`), PRs aus `improve` erreichen das Auto-Merge-Gate nie. `improve` gibt künftig ein Ergebnis zurück, statt selbst einen PR zu öffnen.

### 3. Handeln: Postma-Phasen als Bausteine
Jede Aktion nutzt die Phasen aus der Roadmap (Recherche, Text, Design) und die Prüfungen 1 bis 3. Eine Aktion wählt nur die Bausteine, die sie braucht: `snippet_test` ändert nur Titel und Beschreibung, `new_page` läuft durch alles. Die Bausteine lesen die Projektverträge (Seitenvertrag, Ausgabe, Profil, ICP, Marke).

Zusätzliche Prüfung gegen Massenseiten: **Informationsgewinn.** Die neue Seite muss mindestens drei belegte Aussagen enthalten, die in den Top-5-Ergebnissen fehlen (aus Kundenstimmen, eigenen Daten, Fact-Check). Jede dieser Aussagen muss auf einen Datensatz im Signal-Speicher oder einen Fact-Check-Treffer verweisen, sonst zählt sie nicht. Fehlen drei, wird die Seite verworfen.

### 4. Messen: Änderungsbuch
- Jeder PR schreibt pro Seite einen Eintrag in `seo/changes.json`: Aktionstyp, betroffene Felder, Datum, Ausgangswerte der letzten 28 Tage (Klicks, Impressionen, Position, CTR, Conversions, KI-Zitate).
- **Die Uhr startet beim Merge plus 7 Tagen** (GSC-Verzug `lag = 7` in `src/lib/gsc.js:152`, dazu Deploy und Recrawl). Ungemergte PRs erzeugen keinen Eintrag. Die Ausgangswerte werden zum Zeitpunkt der Bewertung aus der GSC-Historie neu berechnet, nicht aus einem Schnappschuss (`seo/rankings/*.csv` ist in den Projekten gitignored).
- Nach 28 Tagen nur ein Zwischenstand, **das Ergebnis gibt es erst nach 56 Tagen.**
- **Kontrollgruppe:** unveränderte Seiten desselben Projekts im selben Zeitraum. Das Ergebnis ist die Differenz zur Entwicklung der Kontrollgruppe, damit Google-Updates und Saison nicht als Wirkung zählen.
- Ergebnis: positiv, neutral, negativ, oder "zu wenig Daten". Positiv oder negativ nur, wenn die Seite die Mindestzahl Impressionen erreicht und der Effekt größer ist als die Schwankung der Kontrollgruppe im selben Zeitraum.
- Ein `revert`-Kandidat entsteht erst, wenn Zwischenstand (28 Tage) und Ergebnis (56 Tage) beide negativ sind. **Revert-PRs werden nie automatisch gemergt.**
- **Fallback-Kontrolle:** Sind fast alle Seiten verändert, gilt die ganze Website laut GSC ohne die veränderten Seiten als Kontrolle. Bleiben weniger als 10 unveränderte Seiten, startet der Kreislauf keine neuen Rewrites, bis wieder genug da sind.
- **Tests** (`snippet_test`, später Conversion-Tests in den Host-Apps) laufen nur, wenn eine Laufzeitschätzung aus dem vorhandenen Traffic ein Ergebnis in höchstens 8 Wochen erwarten lässt. Für Google gibt es nie zwei Versionen derselben URL (Cloaking).

### 5. Lernen: Playbook und Kalibrierung
- **Playbook** `seo/playbook.json` pro Projekt: Regeln der Form "Aktion X mit Merkmal Y: 4 von 6 positiv". Merkmale sind fest definiert (z. B. Titel mit Zahl, FAQ-Länge, Seitentyp, Suchabsicht), damit sie zählbar bleiben.
- **Globales Playbook:** Ein eigener Job im seo-cli-Repo liest wöchentlich die Ergebnisse aller Projekte über die GitHub-API, mit einem **fein granularen Token, nur Lesezugriff auf Inhalte, nur diese Repos** (nicht der klassische Token mit `repo`-Scope aus der README, der Schreibzugriff auf alle Repos inklusive Kundenprojekt hätte) und schreibt `playbook/global.json`. Projekte mit wenig Daten nutzen die globalen Regeln, eigene Regeln haben Vorrang, sobald genug Belege da sind.
- Regeln fließen in die Bewertung (Wahrscheinlichkeit pro Aktionstyp) und als kurzer Block in die Prompts von `generate` und `improve`.
- **Kalibrierung:** Vorhergesagter und gemessener Nutzen werden verglichen. Liegt die Vorhersage systematisch daneben, werden die Gewichte der Bewertung angepasst.
- **Grenzen des Lernens:** Eine Regel braucht mindestens 5 Ergebnisse, die nicht "zu wenig Daten" sind, und einen Effekt über der Schwankung der Kontrollgruppe. Pro Lauf darf sich ein Gewicht um höchstens 20 % ändern. **Neue oder geänderte Regeln kommen als eigener PR, der nicht automatisch gemergt wird.** Das ist ein seltener manueller Schritt, dafür kann Lernen auf Rauschen nicht unbemerkt die Prompts aller Projekte verändern. Lernen darf Gewichte und Prompt-Hinweise ändern, aber keine Prüfung abschalten und kein Budget erhöhen. Jede neue oder geänderte Regel steht im PR-Text.

## Querschnitt

### Aktuell bleiben
- **Daten:** Ablaufdatum pro Quelle (siehe 1).
- **Wissen:** Die Regeln über Google, Bing und KI-Suche, die heute in `src/prompts/style-default.md` und `generate.md` stehen, wandern in `knowledge/*.md` mit Datum und Quelle pro Regel. Ein monatlicher Job im seo-cli-Repo sucht per Websuche nach Änderungen (Google Search Central, Bing Webmaster Blog, Core Updates) und öffnet einen PR mit Belegen. Prompts lesen `knowledge/` statt fester Texte.
- **Seiten:** `refresh`-Kandidaten für Seiten mit veralteten Fakten.
- **Modelle:** `src/lib/models.js` bleibt die einzige Stelle für Modell-IDs.

### Schnell
- **Täglicher Wächter:** kleiner Job pro Projekt ohne LLM, nur Index-Status und GSC. Er meldet sich per Issue bei Deindexierung oder wenn die letzten 7 Tage gegenüber denselben Wochentagen der Vorwoche über der Schwelle fallen. **Er startet keinen Lauf mit LLM.** Erlaubt ist nur, einen `revert`- oder `refresh`-Kandidaten für den nächsten Wochenlauf vorzumerken.
- **Ein Lauf pro Repo gleichzeitig:** `concurrency`-Gruppe pro Repo im Workflow (heute keine).
- Der volle Lauf bleibt wöchentlich. Batch-API bleibt Standard, weil die Wartezeit in CI keine Rolle spielt.

### Effizient
- **Budget pro Projekt und Monat** in USD und SerpAPI-Abfragen, in `seo.config.yaml`. Gezählt im Projekt-Repo in `seo/budget.json`, nicht mehr in `~/`. Damit ist auch der aktuelle Fehler behoben: Die Datei `~/.seo-cli-serpapi.json` wird in CI nicht zwischen Läufen gespeichert (`.github/workflows/seo-reusable.yml` hat keinen Cache-Schritt), sodass die Grenze von 240 pro Monat in CI nie greift. Das Budget wird **vor jedem bezahlten Aufruf** geprüft, Anthropic-Kosten werden aus den `usage`-Angaben der Antworten gezählt. Fehlt `seo/budget.json` oder ist sie unlesbar, bricht der Lauf ab, statt ohne Grenze weiterzulaufen. Das gemeinsame SerpAPI-Kontingent liest jeder Lauf direkt bei SerpAPI (Account-Endpunkt), das ist der verbindliche Stand über alle Projekte.
- **Modellwahl nach Aufgabe:** Haiku für Klassifizieren und Bereinigen, Sonnet für Bewerten und Prüfen, Opus nur fürs Schreiben.
- **Prompt-Caching:** Projektverträge, ICP, Marke und Playbook bilden einen festen Prompt-Anfang, der gecacht wird. Heute wird nur der System-Prompt gecacht (`src/lib/claude.js:40`).
- **SERP-Cache** im Signal-Speicher statt neuer Abfrage pro Lauf.

### Flexibel
Fünf Schnittstellen, alles andere ist Konfiguration, die `seo init` erkennt:

| Schnittstelle | Beispiele |
|---|---|
| Signal-Adapter | GSC, SerpAPI, Bing, Reviews, Rybbit, KI-Zitate |
| Ausgabe-Adapter | Markdown im Repo, Import-Endpunkt (Shop) |
| Seitenvertrag | erkanntes Schema pro Renderer |
| Aktionstyp | `new_page`, `rewrite`, `snippet_test`, … |
| Prüfung | Validierung, Fact-Check, Informationsgewinn, Render-Check |

### Sicher
- **Notbremse:** Fällt die Zielgröße eines Projekts nach Merges um mehr als 20 % gegenüber der Kontrollentwicklung, pausiert der Kreislauf neue Seiten und Rewrites für dieses Projekt und meldet sich. Nur `revert` und Messung laufen weiter.
- `paused: true` pro Projekt in der Config.
- Fremddaten bleiben in `<<<UNTRUSTED_…>>>`-Blöcken. Signal-Datensätze werden beim Speichern auf reine Daten geprüft (feste Felder, Längengrenzen, keine URLs im Freitext), Personendaten entfernt ein deterministischer Schritt mit eigenen Tests. Prüfung 2 lehnt Seiten ab, die Text aus dem Signal-Speicher wörtlich übernehmen oder neue externe Links enthalten, die nicht aus dem Fact-Check stammen.
- **Kundenprojekte** (punktundpause.de) laufen mit `require_review: true`, auch für neue Seiten.
- **Lebenszeichen:** Jeder Wochenlauf meldet sich, auch ohne Aktion, über einen Pflicht-Kanal (heute ist der Notify-Webhook optional). Bleibt die Meldung aus, schlägt der globale Job Alarm. Fehler im Index-Status werden nicht mehr verschluckt.
- Manuell bleiben: Merge der PRs, die nicht automatisch gemergt werden (Revert, Regeln, Kundenprojekte). Jeder PR enthält: was geändert wurde, warum (Kandidat, erwarteter Nutzen), was gemessen wurde, was gelernt wurde, was es gekostet hat.

## Auslöser, Ziele und Benachrichtigungen

### Heute
n8n-Workflow "SEO: Trigger GitHub Workflows" (`n8n/seo-trigger.json`) stößt jeden Mittwoch 09:00 UTC per `workflow_dispatch` drei identische Läufe an (portfolio-2025, events, zeit). Die Projekt-Workflows haben keinen eigenen Cron, weil GitHub Cron-Jobs in inaktiven Repos abschaltet. Der Gate-Schritt schickt pro Lauf einen Status an den optionalen Webhook, n8n-Workflow "SEO: Notify (GitHub to Gmail)" mailt ihn an a@rafaelalex.de. Neue Projekte müssen von Hand in n8n eingetragen werden.

### Neu: ein Orchestrator statt fester Wochenläufe
- **Projektregister** `projects.yaml` im seo-cli-Repo: pro Projekt Repo, Phase, Budget, Rhythmus, Review-Regel, `paused`. `seo init` trägt neue Projekte automatisch ein (per PR im seo-cli-Repo).
- **Orchestrator-Workflow** `orchestrate.yml` im seo-cli-Repo läuft täglich. n8n bleibt nur die Uhr und ruft genau diesen einen Workflow auf, damit GitHubs Cron-Abschaltung keine Rolle spielt. Der Orchestrator entscheidet pro Projekt, welcher Job fällig ist, verteilt Budget und SerpAPI-Kontingent und startet die Projekt-Workflows per `workflow_dispatch` mit `mode` als Eingabe. Läufe werden über die Woche verteilt, damit sie sich nicht überschneiden.

### Jobs
| Job (`mode`) | Wann | LLM | Zweck |
|---|---|---|---|
| `watch` | täglich, jedes Projekt | nein | Index-Status, Absturz-Erkennung, Lebenszeichen |
| `observe` | täglich, nur abgelaufene Signale | nein (Haiku nur zum Bereinigen) | Signal-Speicher aktuell halten |
| `cycle` | nach Rhythmus der Phase | ja | Entscheiden, Handeln, Messen |
| `learn` | wöchentlich, nach allen `cycle`-Läufen | wenig | Globales Playbook, Kontingent-Planung |
| `knowledge` | monatlich | ja, mit Websuche | Wissens-PR für seo-cli |
| `refresh_contract` | Ereignis: Push im Projekt ändert eine Renderer-Datei | ja | Seitenvertrag neu erkennen |
| `after_merge` | Ereignis: seo-PR gemergt und deployt | nein | Sitemap und IndexNow (heute im Gate), Messuhr im Änderungsbuch starten |
| manuell | `workflow_dispatch` in GitHub oder `seo <befehl>` lokal | je nach Befehl | wie heute |

### Phasen pro Projekt ("mit welchem Ziel")
Die Phase bestimmt, welche Aktionstypen erlaubt sind, wie oft `cycle` läuft und was als Erfolg zählt. Der Orchestrator wechselt sie automatisch und meldet jeden Wechsel.

| Phase | Wann | Erlaubte Aktionen | Rhythmus | Zielgröße |
|---|---|---|---|---|
| `launch` | Neues Projekt, unter 500 Impressionen in 28 Tagen | `new_page` aus Startmodus (externe Nachfrage), Verträge, ICP | 2× pro Woche, solange Budget reicht | Impressionen, indexierte Seiten |
| `grow` | GSC liefert Nachfrage | alle | wöchentlich | Klicks, bei Rybbit Conversions |
| `optimize` | Backlog 4 Wochen leer | `rewrite`, `snippet_test`, `refresh`, `revert` | wöchentlich | CTR, Conversions |
| `maintain` | wenig Potenzial, oder vom Nutzer gesetzt | `refresh`, `revert`, nur `watch` täglich | monatlich | keine Verluste |

Die Notbremse setzt ein Projekt unabhängig von der Phase auf Pause.

### Benachrichtigungen
Grundsatz: Eine Nachricht gibt es nur, wenn du handeln musst oder wenn etwas kaputt ist. Alles andere steht im Wochenbericht. Jede Warnung wird zusätzlich als GitHub-Issue im Projekt-Repo angelegt. Sie kommt einmal und wird nicht wiederholt, solange das Issue offen ist. Ist das Problem behoben, schließt der nächste Lauf das Issue.

| Stufe | Kanal | Inhalt |
|---|---|---|
| **Sofort** | Mail mit hoher Priorität (später zusätzlich Push) | Deindexierung, Notbremse ausgelöst, Lebenszeichen fehlt, zwei fehlgeschlagene Läufe in Folge, Budget überschritten |
| **Handlung nötig** | höchstens eine Sammelmail pro Tag | PRs, die auf dein Review warten (Revert, neue Regeln, Kundenprojekte), je mit einem Satz Begründung und Link |
| **Wochenbericht** | eine Mail montags für alle Projekte | Pro Projekt: Phase, was gemacht und automatisch gemergt wurde, gemessene Ergebnisse (positiv, negativ), gelernte Regeln, Kosten gegen Budget, geplante Aktionen für die Woche |
| **Monatsbericht** | eine Mail am Monatsersten | Entwicklung über 3 Monate, Phasenwechsel, Wissens-PR |
| **Still** | nur im Wochenbericht | automatisch gemergte Routine-PRs, Läufe ohne Aktion |

Die Einzelmail pro Lauf von heute entfällt. Der Webhook wird Pflicht, und Berichte und Mails baut n8n weiter über den bestehenden Gmail-Workflow. Den Inhalt liefert seo-cli als JSON.

## Umbau in Etappen
Kein Neuschreiben. Jede Etappe ist ein eigener Plan und lässt die bestehenden Tests grün.

| Etappe | Inhalt | Warum an dieser Stelle |
|---|---|---|
| A. Fundament (A.1 + A.2) | Status-Commit nach `main`, `concurrency`, Budget vor jedem Aufruf (behebt den Kontingent-Fehler), PR pro Aktion und Gate-Liste, Lebenszeichen, Änderungsbuch und Ergebnisbewertung mit Kontrollgruppe | Ohne Messung kann nichts lernen, und jede spätere Etappe soll ihre Wirkung belegen |
| A2. Orchestrator und Berichte | `projects.yaml`, `orchestrate.yml`, Jobs `watch` und `after_merge`, Phasen, Benachrichtigungsstufen, Wochenbericht, n8n ruft nur noch den Orchestrator | Ab hier läuft das System ohne Pflege in n8n, und du siehst jede Woche, was passiert |
| B. Signal-Speicher | Adapter-Schnittstelle, bestehende Quellen umbauen, AI-Overview-Signal als erster neuer Adapter | Grundlage für alle weiteren Quellen |
| C. Warteschlange | `discover` und `improve` werden Kandidaten-Erzeuger, eine Bewertung, Budget-Abarbeitung, `revert` | Ab hier entscheidet das System nach Nutzen |
| D. Verträge | Seitenvertrag, Ausgabe-Adapter, Projektprofil | Macht neue Projekte wie punktundpause.de möglich |
| E. Kundenstimmen | Voice-Plan, ICP, Marke | Erster großer Qualitätshebel |
| F. Lernen | Playbook pro Projekt und global, Kalibrierung | Braucht Ergebnisse aus A, frühestens 8 Wochen nach A sinnvoll |
| G. Aktuelles Wissen | `knowledge/`, monatlicher Recherche-Job, täglicher Wächter | Unabhängig, kann parallel zu C bis F |
| H. Weitere Quellen und Steps | Bing, KI-Zitate, Rybbit, Startmodus, Render-Check, OG-Bilder, Snippet-Tests | Jeweils als Adapter oder Aktionstyp |

## Bekannte Grenzen
- Wenig Traffic pro Seite: Viele Ergebnisse werden "zu wenig Daten" sein. Deshalb das globale Playbook und Merkmale, die über Seiten hinweg zählbar sind.
- Kontrollgruppe innerhalb eines Projekts ist nicht zufällig gewählt. Das Ergebnis ist ein guter Hinweis, kein Beweis.
- Copilot-Zitate haben noch keine API.

## Offene Fragen
- Push-Kanal für Sofort-Meldungen: Annahme vorerst Mail mit hoher Priorität über den bestehenden n8n-Gmail-Workflow. Ein Push-Dienst (z. B. ntfy oder Pushover über n8n) kann später ergänzt werden.
- Schwelle für `launch` → `grow`: Annahme 500 Impressionen in 28 Tagen, wird nach dem ersten Projekt (punktundpause.de) überprüft.
- Zielgröße pro Projekt: Annahme Conversions über Rybbit, wo vorhanden, sonst Klicks. Rybbit-API-Zugriff wird in Etappe H geprüft.
- Budget-Startwerte: Annahme 30 USD pro Projekt und Monat, wird nach 4 Wochen aus den echten Kosten neu gesetzt.

## Challenge Result
Gelaufen: Architektur und Risiko (immer), Einfachheit (Umfang noch offen). Produkt und Design übersprungen: keine Oberfläche für Nutzer, Ziel vom Nutzer festgelegt.

Konsolidierung: 16 Einwände aus Architektur und Risiko, 13 nach Dedupe, dazu 6 Kürzungsvorschläge.

- **Übernommen:** Stand geht ohne PR verloren (Architektur + Risiko): Status-Commit nach `main` (statt `seo-state`-Branch, siehe A.1), Budget vor jedem Aufruf, Abbruch ohne Budgetdatei.
- **Übernommen:** Gleichzeitige Läufe und `force`-Update (Architektur + Risiko): `concurrency`, Schreiben ohne `force`.
- **Übernommen:** Nur ein PR pro Woche verdrahtet, `improve`-PRs ohne Gate: Branch pro Aktion, Gate-Liste.
- **Übernommen:** Messfenster falsch und Ergebnisse auf Rauschen (Architektur + Risiko): Start ab Merge plus 7 Tage, Ergebnis erst nach 56 Tagen, Signifikanz gegen Kontrollgruppe.
- **Übernommen:** Revert-PRs würden blind gemergt: Revert nur nach zwei negativen Messungen, nie automatisch gemergt.
- **Übernommen:** Lernen auf Rauschen: strengere Schwelle, 20 % pro Lauf, Regeländerungen als eigener PR mit Review.
- **Übernommen:** Wächter ohne Kostengrenze, 24 h für Klicks nicht möglich (Architektur + Risiko): Wächter meldet nur, startet keinen LLM-Lauf.
- **Übernommen:** Token mit Schreibzugriff auf alle Repos (Architektur + Risiko): fein granularer Lese-Token.
- **Übernommen:** Risiko Massenseiten: Monatsgrenze für neue Seiten, Aussagen mit Quellenverweis, Kundenprojekt mit Review.
- **Übernommen:** Prompt-Injection über Reviews: Datensatz-Prüfung, deterministische Bereinigung mit Tests, keine wörtliche Übernahme.
- **Übernommen:** Stille Fehler: Pflicht-Lebenszeichen.
- **Übernommen:** Keine Kontrollgruppe mehr übrig: Fallback auf ganze Website, Pause unter 10 unveränderten Seiten.
- **Übernommen (Reihenfolge, keine Kürzung):** Warteschlange in Etappe C regelbasiert, Nutzen-Bewertung ab Etappe F (Architektur + Einfachheit). Alle Aktionstypen bleiben.
- **Abgelehnt (Nutzerentscheidung 2026-10-06):** Kontrollgruppe weglassen: ohne sie zählen Google-Updates als Wirkung.
- **Abgelehnt (Nutzerentscheidung 2026-10-06):** Globales Playbook verschieben: bei wenig Daten pro Projekt bringt die Summe über Projekte am meisten. Kalibrierung bleibt in Etappe F.
- **Abgelehnt (Nutzerentscheidung 2026-10-06):** Adapter-Schnittstelle erst ab der dritten Quelle: die Roadmap hat schon sechs neue Quellen.
- **Übernommen (Nutzerentscheidung 2026-10-06):** Seitenvertrag und Ausgabe-Adapter erst mit dem Shop (Etappe D), Begründung angepasst.
- **Abgelehnt (Nutzerentscheidung 2026-10-06):** Wissen von Hand pflegen: widerspricht "automatisch statt manuell".
