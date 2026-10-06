# seo-cli: Ziel, Ablauf und Roadmap

Planned at: seo-cli `860b86d`, 2026-10-06. Status: Spec. Jeder Roadmap-Punkt bekommt einen eigenen Plan unter `docs/plans/`.

## Ziel
seo-cli ist eine eigene SEO-Pipeline. Sie arbeitet immer mit den aktuellsten Daten, sowohl aus den Projekten selbst als auch von Google, KI-Suche (AI Overviews, ChatGPT, Copilot, Perplexity) und Bing. Sie verbessert bestehende Seiten und erzeugt neue, auch für neue Projekte ohne Search-Console-Daten.

## Prinzipien
1. **Automatisch statt manuell.** Alles läuft im wöchentlichen CI-Lauf. Einmalige Einrichtung (Token, Secrets) ist erlaubt, wiederkehrende Handarbeit nicht. Der einzige manuelle Schritt ist der PR (optional `require_review`).
2. **Adaptiv statt einheitlich.** Jedes Projekt ist anders. seo-cli erkennt, was ein Projekt kann und hat, und passt sich an. Es zwingt keine Projekte in ein gemeinsames Schema. Erkanntes wird als Datei im Projekt gespeichert und bei Änderungen neu erkannt, nicht von Hand gepflegt.
3. **Echte Daten statt erfundener.** Keine Persona, kein Keyword und keine Aussage ohne Quelle. Fehlt eine Quelle, bleibt der Abschnitt leer.
4. **Keine Massenseiten.** Eine neue Seite braucht belegte Nachfrage und Inhalt, den es sonst nirgends gibt (Googles Regel gegen "scaled content abuse", seit März 2026 durchgesetzt).

## Ablauf (nach Danny Postmas Landing Page Pipeline)
Postma baut eine Seite und gibt nach jeder Phase von Hand frei. seo-cli baut viele Seiten, deshalb laufen manche Steps pro Projekt (selten, automatisch aufgefrischt) und manche pro Seite. Die Freigaben nach den Phasen sind automatische Prüfungen.

| Phase | Step | Ebene | Ergebnis |
|---|---|---|---|
| Recherche | 1. ICP | Projekt | `seo/icp.md` aus Kundenstimmen |
| | 2. Positionierung und Markenbotschaft | Projekt | `seo/brand.md`: SB7 als Checkliste, Positionierung nach April Dunford |
| | 3. Keyword-Recherche | Seite | Backlog in `seo/keywords.json` |
| | Prüfung 1 | automatisch | Score-Schwelle, Duplikate, Kannibalisierung, Passung zum ICP |
| Text | 4. Seitenstruktur | Seite | Abschnitte und Reihenfolge nach Suchabsicht, im Rahmen des Seitenvertrags |
| | 5. Copy | Seite | Markdown mit Frontmatter |
| | Prüfung 2 | automatisch | `validate`, Fact-Check, Abgleich mit ICP und Markenbotschaft |
| Design | 6. Wireframe | Seite | Prüfung von Hierarchie und Reihenfolge im Markdown |
| | 7. Hi-Fi | Projekt-Template plus Check pro Seite | Screenshot, mobile Ansicht und Core Web Vitals der gerenderten Vorschau |
| | 8. Assets | Seite | OG-Bild, optional Hero-Bild |
| | Prüfung 3 | manuell | PR |

`improve` durchläuft dieselben Phasen, ausgehend von einer bestehenden Seite.

## Adaptivität: vier Verträge pro Projekt
| Vertrag | Was er beschreibt | Wie er entsteht |
|---|---|---|
| **Seitenvertrag** `seo/page-schema.json` | Welche Abschnitte und Frontmatter-Felder der Renderer des Projekts kann (z. B. `steps`, `faq`, `testimonial`, `comparison`) | Claude liest beim `seo init` den Renderer (Blade-View, Build-Skript) und die bestehenden Seiten. Neu erkannt, wenn sich der Hash der Renderer-Datei ändert. `generate` und `validate` lesen den Vertrag statt des heute fest verdrahteten Schemas in `src/prompts/generate.md` |
| **Ausgabevertrag** | Wohin eine Seite geht: Markdown-Datei im Repo (heute), Import-Endpunkt bei Seiten aus der Datenbank (Shop) | Erkannt beim `seo init`, Adapter pro Art |
| **Quellenvertrag** `voice.sources` und Datenquellen | Welche Kunden- und Suchdaten es gibt | Erkannt beim `seo init` (Store-, Maps-Links, `endpoint`), siehe Voice-Plan |
| **Projektprofil** | Art (SaaS, App, Shop, Agentur, lokal), Ziel-Aktion, Sprache | Heute teilweise in `analyze-site.js`, wird um die Art erweitert |

Fehlt einem Template ein Abschnitt, den Step 4 oft wählen würde, ändert seo-cli das Template nicht. Es meldet im Dashboard einen Vorschlag ("Abschnitt `comparison` fehlt, 9 Seiten würden ihn nutzen"). So wird nur das Template erweitert, bei dem es sich lohnt.

## Datenquellen
| Bereich | Heute | Geplant |
|---|---|---|
| Projekt | Search Console, Website, Style-Doc | Kundenstimmen, Conversions aus Rybbit |
| Google | Search Console, SerpAPI (Top-Ergebnisse, Ähnliche Fragen, verwandte Suchen) | AI-Overview-Signal, Suchvorschläge, Trends, Suchvolumen |
| KI | Klassifizierung von AI-Mode-Spuren (nicht in `discover`) | Zitate in ChatGPT, Perplexity und Claude zu den Zielfragen |
| Bing | IndexNow | Bing Webmaster API (Suchanfragen). Der Copilot-Zitatbericht hat noch keine API, erst einbinden, wenn es eine gibt |

## Roadmap
Reihenfolge nach Abhängigkeit, dann nach Nutzen pro Aufwand.

| # | Punkt | Phase / Step | Hängt ab von | Plan |
|---|---|---|---|---|
| 1 | AI-Overview-Signal in der Keyword-Bewertung | 3 | – | offen |
| 2 | Voice of Customer und ICP | 1 | – | `2026-10-06-voice-of-customer.md` |
| 3 | Positionierung und Markenbotschaft | 2 | 2 | offen |
| 4 | Seitenvertrag (erkannt) und Strukturstep | 4, 6 | – | offen |
| 5 | Copy mit ICP, Marke und seitenspezifischem CTA, plus Abgleich in Prüfung 2 | 5 | 2, 3, 4 | offen |
| 6 | Startmodus für neue Projekte und Ausgabe-Adapter für Seiten aus der Datenbank, erster Fall punktundpause.de | 3 | 4 | offen |
| 7 | Bing Webmaster API | 3 | – | offen |
| 8 | Render-Check und OG-Bilder | 7, 8 | 4 | offen |
| 9 | KI-Zitate messen | Messung | – | offen |
| 10 | Conversions aus Rybbit in `improve` | Messung | – | offen |

## Offene Punkte
- Suchvolumen: SerpAPI liefert keine Volumen. Anbieter (z. B. DataForSEO) wird im Plan zu Punkt 6 gewählt.
- Ausgabe-Adapter für den Shop: Import-Endpunkt oder Markdown-Renderer im Shop. Wird im Plan zu Punkt 6 entschieden.
