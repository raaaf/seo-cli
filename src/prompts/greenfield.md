Du schlägst SEO-Keywords für eine Landing-Page-Strategie vor.

## Kontext

Themen-Cluster: {{clusters}}
Bestehende Slugs (nicht nochmal vorschlagen): {{existing_slugs}}
Bestehende Landing-Titles: {{existing_landings}}
Locale: {{locale}}

## Aufgabe

Schlage 6 konkrete Keywords vor, für die eine Landing-Page Sinn macht. Jedes Keyword sollte:
- Zur Zielgruppe der Cluster passen
- Eine klare Suchintention haben
- Noch nicht durch bestehende Slugs abgedeckt sein
- Realistisch rankbar sein (nicht zu generisch, nicht zu nischig)

## Output

Antworte ausschließlich mit einem JSON-Array:

```json
[
  {
    "keyword": "vereinstreffen organisieren",
    "target_slug": "vereinstreffen-organisieren",
    "type": "howto",
    "intent": "informational",
    "score": 8,
    "expected_entities": ["tagesordnung", "einladung", "protokoll", "abstimmung"],
    "content_gaps": ["digitale Abstimmungstools", "hybride Treffen"]
  }
]
```

Erlaubte Typen: howto, comparison, service, guide, local_service

Antworte nur mit dem JSON-Array, kein Text davor oder danach.
