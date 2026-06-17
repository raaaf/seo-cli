# Writing Style — Default Best Practices (May 2026)

These rules apply when no project-specific style doc exists.
A project-specific style doc (from `seo init`) always takes precedence.

## Core principle

Write for people trying to accomplish something. Match search intent exactly in the hero.
Each page must have genuinely unique value — programmatic duplication across URLs without
differentiated content is a named spam violation as of September 2025.

## E-E-A-T signals (essential)

- Front-load evidence: concrete numbers, specific outcomes, realistic scope
- Cite sources for any factual claims (link to external references where relevant)
- Include first-person experience signals where appropriate ("When we tested...", "In practice...")
- Add an author attribution line if the platform supports it
- Acknowledge limitations honestly — it builds trust and signals genuine expertise

## AI Overviews / LLM citation structure

Structure content so Gemini and other LLMs can extract "nuggets":
- Start each H2 and H3 with a 1–2 sentence bold summary before elaborating
- The first 40–50 words of each section are the most likely to be cited
- Include original data, proprietary observations, or a contrarian perspective per page
- Use `SameAs` and `MainEntityOfPage` schema to link to the Knowledge Graph

## Tone

Direct and useful. No thought-leadership, no marketing padding.
Address the reader directly ("you"), active voice, real examples over vague claims.

## Sentence rhythm

- Medium-length sentences with connectives (because, but, and, so, although)
- Short sentences sparingly — only when they land a clear point
- No chains of 3+ two-word sentences
- Paragraphs: 2–4 sentences, plenty of white space

## Forbidden phrases (AI-content red flags)

Never use: In today's fast-paced world, It's important to note, Comprehensive solution,
Seamless experience, Revolutionary, Best-in-class, State-of-the-art, Cutting-edge,
Holistic approach, Tailored solution, Leverage, Synergy, Game-changer, Empower, Unlock,
Simply (as minimizer), Just (as minimizer), Basically, Actually, Robust, Innovative,
Transformative, World-class, Industry-leading, Next-level, End-to-end.

## Internal links

Include 2–4 internal links to related pages. Link anchor text should describe the target
specifically, not generic phrases like "click here" or "learn more".

## CTAs

Direct and specific:
- "Start free — no credit card" not "Learn more"
- "Book a 20-minute demo" not "Get in touch"
- "Download for iOS" not "Available on mobile"

## Structure

- H2 for main sections, H3 for subsections
- Each H2/H3 starts with a bold 1–2 sentence summary
- Include a FAQ section (4–6 real questions) — valuable for AI Overview citations
  even though FAQ schema no longer produces rich results in Google Search
- No "Conclusion" section

## Language purity (German pages)

- Do not drop English words mid-sentence in DE prose, whether lowercase or capitalized.
  Capitalizing an English noun does NOT turn it into an allowed loanword. If German has a
  word, use it.
  Bad (lowercase): "Die venue entscheidet", "Beim catering", "Gute entertainment", "Ein klares Theme".
  Bad (capitalized, just as wrong): "ein gemeinsamer Activity Calendar", "Member Engagement entsteht",
  "Volunteers koordinieren", "Geschenke für employee recognition".
  Good: "Die Location entscheidet", "Beim Catering", "Gute Unterhaltung", "Ein klares Motto",
  "ein gemeinsamer Jahreskalender", "Mitgliederbeteiligung entsteht", "Helfer koordinieren",
  "Geschenke zur Mitarbeiterwürdigung".
- Only a closed set of single-word established loanwords is allowed (common German usage,
  capitalized as nouns): Catering, Tool, App, SaaS, MVP, Stack, Hosting, Plugin, Template, Workshop.
  Anything outside this set that has a German equivalent must use the German word. Multi-word
  English phrases are never acceptable in DE prose.
- No anglicism "in 2026" — write "2026" or "im Jahr 2026".

## Facts must be current

- Use German tax/legal thresholds as currently in force, not values from older years
  stamped with a past year label as if still authoritative.
- For statistics from studies, name the source year explicitly only when the source
  itself is dated and you have verified the citation. Otherwise phrase neutrally.

## Real names only

- Never invent product, tool, software, organization, or person names.
- If you cannot confidently name a real tool that fits, describe the category instead.
