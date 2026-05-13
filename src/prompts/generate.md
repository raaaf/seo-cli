You are writing an SEO landing page as a Markdown file with YAML frontmatter.

## Context

Keyword: {{keyword}}
Slug: {{slug}}
Type: {{type}}
Search intent: {{intent}}
Geo scope: {{geo_scope}}
Location (if local): {{location}}
Expected entities (must appear naturally): {{expected_entities}}
Content gaps vs. top-3 SERP (score points here): {{content_gaps}}
Primary CTA: {{primary_cta}}
Output language: {{locale}}
People Also Ask (basis for FAQ): {{people_also_ask}}
Related searches (use for internal link anchors): {{related_searches}}

## Writing style

{{style}}

## Frontmatter schema

```yaml
slug: organise-grill-party
metaTitle: "Organise a Grill Party – Checklist & Tips"   # 50–60 chars
metaDescription: "How to plan a grill party: shopping list, invites, timeline. With free checklist."  # 140–160 chars
type: howto   # howto | comparison | service | guide | local_service
geo_scope: global   # global | local
hero:
  eyebrow: "Event planning made easy"
  headline: "Organise a Grill Party Without the Chaos"
  sub: "Checklist, timeline and everything you actually need."
tldr: "A grill party needs: invites 2 weeks ahead, drinks for 2–3 per person, 1kg charcoal per 5 people, a rain backup plan."
updated: "{{today}}"
primary_cta: {{primary_cta}}
seo:
  target_keyword: "{{keyword}}"
  expected_entities: {{expected_entities_yaml}}
```

## Structure by type

**howto**: Hero → TL;DR → Step-by-step (H2 per step) → Checklist → FAQ → CTA
**comparison**: Hero → TL;DR → Comparison table → Pros/cons per option → Recommendation → FAQ → CTA
**service**: Hero → Problem → Solution → Scope → Process → FAQ → CTA
**guide**: Hero → TL;DR → Main sections (H2) → FAQ → CTA
**local_service**: Hero → Local context (mention location naturally, 2–3 times) → Service → Why local matters → Local FAQ → CTA

## For local_service pages specifically

If geo_scope is "local":
- Mention the location ({{location}}) naturally in hero, at least one H2, and the FAQ
- Include a "Serving [location]" or similar signal in the meta description
- Add LocalBusiness schema (see schema section below)
- Do NOT just swap the city name into a generic template — add genuinely local context

## Schema.org (include as JSON-LD in a fenced ```json block at the end of the file)

Choose the appropriate schema based on type:

**howto** → HowTo schema with steps extracted from the content
**comparison / guide** → Article schema (headline, description, datePublished)
**service / local_service** → LocalBusiness or SoftwareApplication schema
**All pages** → Add FAQPage schema from the FAQ section (still valuable for AI citation in 2026)

Example HowTo + FAQ:
```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "HowTo",
      "name": "{{keyword}}",
      "description": "...",
      "step": [
        { "@type": "HowToStep", "name": "Step 1", "text": "..." }
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Question text",
          "acceptedAnswer": { "@type": "Answer", "text": "Answer text" }
        }
      ]
    }
  ]
}
```

## Internal links

Include 2–4 internal links in the body. Use related_searches as anchor text ideas.
Format as markdown links: [anchor text](/slug). Use descriptive anchors, not "click here".

## Requirements

- Minimum 800 words in the body (excluding frontmatter and schema)
- Keyword in hero.headline, in the first 100 words, and in at least one H2
- All expected_entities must appear naturally
- Cover at least 2 aspects from content_gaps
- FAQ: 4–6 questions from people_also_ask and related_searches
- CTA at the end matching primary_cta
- No "Conclusion" section
- No unnatural keyword repetition
- Write entirely in the language of the output locale ({{locale}})

## Validator feedback (if this is a retry)

{{validator_feedback}}

## Output

Output only the finished Markdown file. No text before or after, no ``` wrapper around the whole file.
