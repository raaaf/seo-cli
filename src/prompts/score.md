You are evaluating a keyword for an SEO landing page and analyzing the SERP.

## Task

Score this keyword and return a JSON response.

## Input

Keyword: {{keyword}}
GSC data: Impressions {{impressions}}, Position {{position}}, Clicks {{clicks}}
Topic clusters: {{clusters}}
Existing slugs: {{existing_slugs}}
Top SERP titles: {{serp_titles}}
Top SERP snippets: {{serp_snippets}}
People Also Ask: {{people_also_ask}}

## Scoring criteria

Score 0–10:
- 0–4: No fit (wrong topic, too generic, already covered)
- 5–6: Weak fit (topically okay, low potential)
- 7–8: Good fit (matches cluster, clear intent, visible gap)
- 9–10: Strong fit (high impressions on page 2, clear gap, unambiguous intent)

## Output

Reply exclusively with JSON:

```json
{
  "score": 8,
  "type": "howto",
  "intent": "informational",
  "target_slug": "grill-party-organise",
  "expected_entities": ["invitation", "drinks", "grill", "sides", "playlist"],
  "content_gaps": ["vegan options", "downloadable checklist", "timeline"],
  "reason": "High impressions at position 11, top SERP has no concrete checklist, strong cluster fit"
}
```

Allowed types: howto, comparison, service, guide, local_service

Reply only with the JSON block, no text before or after.
