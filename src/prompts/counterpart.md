You are creating a counterpart landing page: a natural-language ADAPTATION of an
existing page for a different locale and audience, not a literal translation.
The app reads structured data from YAML frontmatter and renders each section
independently (same schema as the source page).

## Task

Source locale: {{source_locale}}
Target locale: {{target_locale}}
Site name: {{site_name}}
Today: {{today}}

Adapt the source page below into {{target_locale}} for an international audience.
Rework the phrasing, examples, and framing so it reads as if written natively for
{{target_locale}} readers, not translated word-for-word. Keep the same overall
structure and frontmatter field set: hero, tldr, steps, checklist, faq,
related_pages, meta_title, meta_description, updated.

Localize country-specific specifics sensibly. Example: a German GEMA reference
becomes "your local performing rights organization"; a German legal or tax detail
becomes a generic equivalent statement rather than a fabricated foreign-law claim.
Do not invent country-specific facts, prices, or laws for the target locale.

Slugs already used in {{source_locale}} (do not reuse, do not reference as
related_pages here): {{existing_slugs_source}}

Slugs already used in {{target_locale}} (do not reuse; these are the ONLY slugs
you may reference in related_pages): {{existing_slugs_target}}

Choose a short noun-phrase slug for the new page (e.g. `club-events`,
`team-building-event`) that collides with NEITHER list above, and set `slug:`
to it. Do NOT include an `alternate` field in the frontmatter; the reciprocal
link between the two pages is injected by the pipeline afterward, not by you.

## Source page

The source page is our own already-generated, already-reviewed content (not
external/untrusted input), so it is included directly below rather than wrapped
in an untrusted-data fence.

{{source_markdown}}

## Output format

Output a complete Markdown file, frontmatter first, then body, matching the
structure of the source page.

- `meta_title`: <= 60 chars, adapted for {{target_locale}}, no site name suffix needed.
- `meta_description`: 120–160 chars.
- `slug`: the new noun-phrase slug you chose (see above). No `alternate` field.
- `updated`: "{{today}}"
- `related_pages`: only slugs from the "{{target_locale}}" list above, never a
  "{{source_locale}}" slug, never an invented slug. If that list is "none",
  omit `related_pages` entirely rather than inventing or cross-referencing one.
- Body: same word-count range as the source, 800–1400 words (aim 900–1100).
  Flowing prose only: no steps, checklist items, or FAQ in the body.
- NO em-dashes (—). Use comma, colon, or period instead.
- NO double-hyphen separator ( -- ). Restructure the sentence.
- NO emoji anywhere in the file.
- Write entirely in {{target_locale}}.

## Validator feedback (if this is a retry)

{{validator_feedback}}

## Output

Output only the finished Markdown file. No text before or after.
