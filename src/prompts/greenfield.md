You are suggesting SEO keywords for a landing page strategy.

## Context

Topic clusters: {{clusters}}
Existing slugs (do not suggest again): {{existing_slugs}}
Existing landing titles: {{existing_landings}}
Target locale: {{locale}}

## Task

Suggest 6 concrete keywords for which a landing page makes sense. Each keyword should:
- Fit the target audience of the clusters
- Have a clear search intent
- Not already be covered by existing slugs
- Be realistically rankable (not too generic, not too niche)
- Match the locale language

## Output

Reply exclusively with a JSON array:

```json
[
  {
    "keyword": "vereinstreffen organisieren",
    "target_slug": "vereinstreffen-organisieren",
    "type": "howto",
    "intent": "informational",
    "score": 8,
    "expected_entities": ["agenda", "invitation", "minutes", "vote"],
    "content_gaps": ["digital voting tools", "hybrid meetings"]
  }
]
```

Allowed types: howto, comparison, service, guide, local_service

Reply only with the JSON array, no text before or after.
