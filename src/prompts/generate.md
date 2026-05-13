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
Existing slugs you may link to (ONLY use these for internal links): {{existing_slugs}}

## Writing style

{{style}}

## Frontmatter schema

```yaml
slug: organise-grill-party
meta_title: "Organise a Grill Party – Checklist & Tips"   # 50–60 chars
meta_description: "How to plan a grill party: shopping list, invites, timeline. With free checklist."  # 140–160 chars
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

## Schema.org (add as `schema:` YAML field in the frontmatter, not in the body)

**Note:** FAQPage rich results deprecated May 2026. Do NOT add FAQPage schema.
HowTo only for genuinely howto pages.

Add a `schema:` key to the frontmatter containing the JSON-LD as a YAML-compatible JSON string.
The app reads this field and renders it as `<script type="application/ld+json">`.

Choose schema by type:
- **howto** → HowTo with steps
- **comparison / guide** → Article
- **service / local_service** → SoftwareApplication or LocalBusiness

All pages: include `mainEntityOfPage`, `BreadcrumbList`, `SameAs` on Organization.

Frontmatter example (add after the other fields, before the closing `---`):

```
schema: |
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "HowTo",
        "name": "{{keyword}}",
        "description": "...",
        "mainEntityOfPage": { "@type": "WebPage", "@id": "CANONICAL_URL" },
        "step": [
          { "@type": "HowToStep", "position": 1, "name": "Step 1", "text": "..." }
        ]
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": "BASE_URL" },
          { "@type": "ListItem", "position": 2, "name": "{{keyword}}", "item": "CANONICAL_URL" }
        ]
      }
    ]
  }
```

CANONICAL_URL and BASE_URL are placeholders — they will be replaced automatically.

## Internal links

Include 2–4 internal links in the body. Use related_searches as anchor text ideas.
Format as markdown links: [anchor text](/slug).
ONLY link to slugs from the "Existing slugs" list above. If no existing slug fits, omit the link.
Never invent slugs that do not exist in that list.

## Requirements

- Minimum 800 words in the body (excluding frontmatter and schema)
- Keyword in hero.headline, in the first 100 words, and in at least one H2
- All expected_entities must appear naturally
- Cover at least 2 aspects from content_gaps — these must be genuinely unique insights,
  not rewrites of what already ranks. Programmatic duplication is a Google spam violation.
- Each H2 and H3 must start with a bold 1–2 sentence summary before elaborating
  (Google AI Overviews extracts from the first 40–50 words of each section)
- Include at least one concrete, verifiable example or publicly available data point
- NEVER fabricate statistics, customer numbers, years of experience, or case studies.
  Do not write "we have helped X customers", "in our experience over Y years", or any
  first-person claim that implies operational history. The site may be new. If you need
  a credibility signal, cite a real external source instead.
- FAQ: 4–6 real questions from people_also_ask and related_searches
- No FAQPage schema (deprecated May 2026)
- CTA at the end matching primary_cta
- No "Conclusion" section
- No unnatural keyword repetition
- Write entirely in the language of the output locale ({{locale}})

## Validator feedback (if this is a retry)

{{validator_feedback}}

## Output

Output only the finished Markdown file. No text before or after, no ``` wrapper around the whole file.
