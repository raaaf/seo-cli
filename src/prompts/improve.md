You are improving an existing SEO landing page that already ranks. It is not a
draft and it is not yours to rewrite from scratch. Change what the Search Console
data says is wrong, keep everything else.

## Context

Slug: {{slug}} (do NOT change it)
Output language: {{locale}}
Site: {{site_name}}
Today: {{today}}

Diagnosis: {{problem}}

Over the last 28 days the page collected {{impressions}} impressions and
{{clicks}} clicks, best position {{best_position}}.

## What people actually searched to reach this page

| Query | Position | Impressions | Clicks |
|---|---|---|---|
{{query_table}}

This table is the whole point of the exercise. It is what people typed, not what
we assumed they would type when the page was written.

## What to change

**When the diagnosis is a snippet problem** (ranking well, no clicks): the
content is fine, the entry in the result list is not. Rewrite `meta_title` and
`meta_description` so they answer the top queries in the words those queries use.
A title that reads like a section heading loses to one that names the outcome.
Keep the title under 60 characters and the description between 140 and 160, and
do not repeat the title in the description. Touch the body only where a top query
is not answered at all.

**When the diagnosis is a ranking or relevance problem**: the page is close but
does not fully answer what is being asked. Find the queries in the table that the
page answers weakly or not at all, and extend the page to cover them: a new
section, additional FAQ entries, a sharper opening paragraph. Also align
`meta_title` and `meta_description` with the strongest queries.

In both cases:

- Keep the slug, the frontmatter schema and the existing structure.
- Keep the address form (du or Sie) exactly as the page uses it now.
- Keep every section that is already there unless it is factually wrong. You are
  extending and sharpening, not replacing.
- Do not invent facts, figures, laws, prices or sources to fill a gap. If a query
  demands a number you do not have, answer it qualitatively.
- **Never claim a service, tool, technology or qualification the current page
  does not already claim**, even when a query asks for it. A query for a tool we
  do not offer is not a licence to say we offer it. Either leave that query
  unanswered or address it honestly with what the page does offer.
- Do not add an em-dash, a double hyphen or an emoji anywhere.
- Keep the body between 800 and 1400 words.
- `updated:` becomes {{today}}.

## Output

Return the complete file: YAML frontmatter, then the markdown body. No code
fence, no commentary before or after, nothing but the file.

## The current page

{{markdown}}
