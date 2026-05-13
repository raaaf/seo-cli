Du schreibst eine SEO-Landing-Page als Markdown-Datei mit YAML-Frontmatter.

## Kontext

Keyword: {{keyword}}
Slug: {{slug}}
Typ: {{type}}
Suchintention: {{intent}}
Erwartete Entities (müssen vorkommen): {{expected_entities}}
Content-Lücken gegenüber Top-3-SERP (hier punkten): {{content_gaps}}
Primary CTA: {{primary_cta}}
Locale: {{locale}}
People Also Ask (Basis für FAQ): {{people_also_ask}}
Related Searches (für interne Links und semantische Tiefe): {{related_searches}}

## Schreibstil

{{style}}

## Frontmatter-Schema

```yaml
slug: grillparty-organisieren
metaTitle: "Grillparty organisieren – Checkliste & Tipps | Events App"   # 50–60 Zeichen
metaDescription: "Wie du eine Grillparty planst: Einkaufsliste, Gäste einladen, Zeitplan. Mit kostenloser Checkliste."  # 140–160 Zeichen
type: howto   # howto | comparison | service | guide | local_service
hero:
  eyebrow: "Eventplanung leicht gemacht"
  headline: "Grillparty organisieren ohne Chaos"
  sub: "Checkliste, Zeitplan und was du wirklich brauchst."
tldr: "Eine Grillparty braucht: Einladungen 2 Wochen vorher, Getränke für 2–3 pro Person, Grillkohle für 1 kg pro 5 Personen, einen Regenwetter-Plan."
updated: "{{today}}"
primary_cta: {{primary_cta}}
geo_scope: global   # global | local
seo:
  target_keyword: "{{keyword}}"
  expected_entities: {{expected_entities_yaml}}
```

## Aufbau je nach Typ

**howto**: Hero → TL;DR → Schritt-für-Schritt (H2 pro Schritt) → Checkliste → FAQ → CTA
**comparison**: Hero → TL;DR → Vergleichstabelle → Pro/Contra je Option → Empfehlung → FAQ → CTA
**service**: Hero → Problem → Lösung → Leistungsumfang → Prozess → FAQ → CTA
**guide**: Hero → TL;DR → Hauptsektionen (H2) → Zusammenfassung → FAQ → CTA
**local_service**: Hero → Lokaler Kontext → Leistung → Warum lokal → FAQ → CTA

## Anforderungen

- Mindestens 800 Wörter im Body
- Keyword in H1, in den ersten 100 Wörtern, in mindestens einer H2
- Alle expected_entities müssen natürlich vorkommen
- Mindestens 2 Aspekte aus content_gaps abdecken
- FAQ: 4–6 Fragen, aus people_also_ask und related_searches ableiten
- CTA am Ende: je nach primary_cta passenden Text wählen
- Kein "Fazit"-Abschnitt
- Keine Keyword-Wiederholung die unnatürlich klingt

## Output

Gib ausschließlich die fertige Markdown-Datei aus. Kein Text davor oder danach, kein ```-Block drumherum.
