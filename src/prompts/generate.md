You are writing an SEO landing page as a Markdown file with YAML frontmatter.
The app reads structured data from YAML frontmatter and renders each section independently.

## How the app renders this file

- `hero` → H1, sub-headline
- `tldr` → highlighted answer box at the top
- Body (markdown after `---`) → flowing prose section
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
meta_title: "Keyword – Kurzer Nutzen"   # 50–60 chars. No English words (Guide, Tips, Howto) if locale is de. No site name suffix needed.
meta_description: "Was diese Seite löst. Konkret, kein Blabla."  # 140–160 chars
updated: "{{today}}"
hero:
  eyebrow: "Kurze Kategoriebezeichnung in {{locale}}"   # NEVER use English type labels like "Howto", "Guide", "Service"
  headline: "Handlungsorientierte Headline mit Keyword"
  sub: "1–2 Sätze. Konkreter Nutzen, kein Hype."
tldr: "Direkte Antwort in genau 40–60 Wörtern (wird maschinell geprüft). Nur öffentlich prüfbare Fakten."
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
  - existing-slug-one  # Only use slugs from the list above — they are pre-filtered for {{locale}}.
  - existing-slug-two  # An EN page must only reference EN slugs; a DE page only DE slugs.
```

### Body (after the closing `---`)

MINIMUM 800 WORDS. Count carefully before finishing — if the body is under 800 words, keep writing.
Target 900–1100 words. The body is the main content; frontmatter steps/faq/checklist are UI supplements only.

- Starts directly with context/problem/insight — no H1 (the app renders hero)
- Exactly 4–5 H2 sections, each introduced by a bold 1–2 sentence summary (AI Overviews citation bait)
- Each H2 section: minimum 150 words of prose
- Use H3 for sub-points where needed
- Cover content_gaps with concrete, verifiable information
- All expected_entities must appear naturally
- 2–4 internal links to existing slugs: [anchor text](/slug)
- NEVER put FAQ questions, numbered steps, or bullet checklists in the body — those belong in frontmatter only
- No fabricated statistics ("we helped X customers", "Y years of experience")
- Include at least 5 concrete numbers/digits (prices, percentages, counts, dates)
- Cite external sources for factual claims: use markdown links [Quelle](https://...) for studies, statistics, organizations (e.g. Statista, BVDW, w3techs.com)
- Include at least 1–2 external links to authoritative sources — strengthens GEO/E-E-A-T
- NO em-dashes (—). Use comma, colon, or period instead.
- NO double-hyphen separator ( -- ). Restructure the sentence.
- NO emoji anywhere in the file
- Write entirely in {{locale}}

## Validator feedback (if this is a retry)

{{validator_feedback}}

## Output

Output only the finished Markdown file. No text before or after.
