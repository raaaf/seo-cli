You are writing an SEO landing page as a Markdown file with YAML frontmatter.
The page renders in a Laravel app. You must match the exact structure it expects.

## How the app renders this file

The app reads structured data from YAML frontmatter and renders each section independently:
- `hero` → H1, sub-headline
- `tldr` → highlighted answer box at the top
- Body (markdown after `---`) → flowing prose section
- `related_features` → feature chip row
- `steps` → numbered step list
- `checklist` → visual checklist grid
- `faq` → accordion FAQ
- `related_pages` → related guides grid

Do NOT put steps, checklist items, or FAQ in the markdown body.
The body is for flowing prose only: intro, context, background, why this matters.

## Context

Keyword: {{keyword}}
Slug: {{slug}}
Type: {{type}}
Search intent: {{intent}}
Geo scope: {{geo_scope}}
Expected entities (must appear naturally in the body): {{expected_entities}}
Content gaps vs. top-3 SERP (cover in body): {{content_gaps}}
Output language: {{locale}}
People Also Ask (source for faq entries): {{people_also_ask}}
Related searches (use for related_pages and body links): {{related_searches}}
Existing slugs you may use for related_pages and body links: {{existing_slugs}}

## Writing style

{{style}}

## Output format

Output a complete Markdown file. Frontmatter first, then body.

### Frontmatter fields (REQUIRED)

```yaml
slug: {{slug}}
meta_title: "Keyword – Short benefit | Site"   # 50–60 chars
meta_description: "What this page does. Concrete, no fluff."  # 140–160 chars
updated: "{{today}}"
hero:
  eyebrow: "Short category label"
  headline: "Action-oriented headline with keyword"
  sub: "1–2 sentence sub-headline. Concrete benefit, no hype."
tldr: "Direct answer in 2–3 sentences. Publicly verifiable facts only. No invented statistics."
related_features:
  - rsvp       # only include features genuinely relevant to this topic
  - bring      # available: rsvp, bring, gift, photos, tasks, comments, carpool,
               # surveys, expenses, tickets, timeslots, groups, recurring, attendance, qr
steps:         # 4–6 steps for howto/guide types. Omit for comparison/service.
  - title: "Short action title"
    description: "One sentence. Concrete."
checklist:     # 5–8 items. Short phrases, no full sentences.
  - "Item one"
  - "Item two"
faq:           # 4–6 entries from people_also_ask. Real questions, real answers.
  - q: "Question from search?"
    a: "Concise, factual answer. 2–4 sentences."
related_pages: # 2–4 slugs from existing_slugs only. Never invent slugs.
  - existing-slug-one
  - existing-slug-two
seo:
  target_keyword: "{{keyword}}"
```

### Body (after the closing `---`)

300–500 words of flowing prose:
- Starts directly with context/problem/insight — no H1 (the app renders that from hero)
- Use H2 and H3 for sub-sections if needed
- Start each H2/H3 with a bold 1–2 sentence summary (AI Overviews citation)
- Cover content_gaps with concrete, verifiable information
- All expected_entities must appear naturally
- 2–4 internal links to existing slugs: [anchor text](/slug)
- No FAQ, no checklist, no numbered steps (those are in frontmatter)
- No fabricated statistics ("we helped X customers", "Y years of experience")
- Cite external sources for factual claims where relevant
- Write entirely in {{locale}}

## Validator feedback (if this is a retry)

{{validator_feedback}}

## Output

Output only the finished Markdown file. No text before or after.
