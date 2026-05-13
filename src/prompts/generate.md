You are writing an SEO landing page as a Markdown file with YAML frontmatter.

## Context

Keyword: {{keyword}}
Slug: {{slug}}
Type: {{type}}
Search intent: {{intent}}
Expected entities (must appear naturally): {{expected_entities}}
Content gaps vs. top-3 SERP (score points here): {{content_gaps}}
Primary CTA: {{primary_cta}}
Output language: {{locale}}
People Also Ask (basis for FAQ): {{people_also_ask}}
Related searches (for internal links and semantic depth): {{related_searches}}

## Writing style

{{style}}

## Frontmatter schema

```yaml
slug: organise-grill-party
metaTitle: "Organise a Grill Party – Checklist & Tips | Events App"   # 50–60 chars
metaDescription: "How to plan a grill party: shopping list, invites, timeline. With free checklist."  # 140–160 chars
type: howto   # howto | comparison | service | guide | local_service
hero:
  eyebrow: "Event planning made easy"
  headline: "Organise a Grill Party Without the Chaos"
  sub: "Checklist, timeline and everything you actually need."
tldr: "A grill party needs: invites 2 weeks ahead, drinks for 2–3 per person, 1kg charcoal per 5 people, a rain backup plan."
updated: "{{today}}"
primary_cta: {{primary_cta}}
geo_scope: global   # global | local
seo:
  target_keyword: "{{keyword}}"
  expected_entities: {{expected_entities_yaml}}
```

## Structure by type

**howto**: Hero → TL;DR → Step-by-step (H2 per step) → Checklist → FAQ → CTA
**comparison**: Hero → TL;DR → Comparison table → Pros/cons per option → Recommendation → FAQ → CTA
**service**: Hero → Problem → Solution → Scope → Process → FAQ → CTA
**guide**: Hero → TL;DR → Main sections (H2) → Summary → FAQ → CTA
**local_service**: Hero → Local context → Service → Why local → FAQ → CTA

## Requirements

- Minimum 800 words in the body
- Keyword in hero.headline, in the first 100 words, and in at least one H2
- All expected_entities must appear naturally
- Cover at least 2 aspects from content_gaps
- FAQ: 4–6 questions, derived from people_also_ask and related_searches
- CTA at the end: choose wording appropriate for the primary_cta value
- No "Conclusion" section
- No unnatural keyword repetition
- Write entirely in the language specified by the output locale ({{locale}})

## Output

Output only the finished Markdown file. No text before or after, no ``` wrapper around it.
