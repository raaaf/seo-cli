# src/prompts: prompt templates

Cross-cutting rules: root `CLAUDE.md`. The steps that fill these templates: `src/steps/CLAUDE.md`.

`src/prompts/` contains markdown templates with `{{placeholder}}` substitution via `lib/template.js#fillTemplate` (single-pass, no templating engine). Untrusted external data (SerpAPI titles/snippets, GSC queries, fetched site copy) is wrapped in `<<<UNTRUSTED_*_START>>>` / `<<<UNTRUSTED_*_END>>>` markers inside the templates so the model treats it as data, not instructions:

- `score.md` — keyword scoring, returns JSON
- `greenfield.md` — keyword discovery without GSC data (only used when `greenfield: true`)
- `review.md` — fact check with web search, returns findings as JSON
- `assess.md`: content assessment of an index alert whose live fetch is clean, returns `likely_causes` and `actions` as JSON
- `link-judge.md`: topic judge for inbound links (Haiku 5.5), returns `judgments` as JSON
- `improve.md` — rewrite of an existing page against its real GSC queries
- `overlay.md`: shop product/category meta title, description and intro, returns JSON (`meta_title`, `meta_description`, `intro`)
- `recipe-overlay.md`: recipe page meta title, description, intro and "Gut zu wissen" notes, returns JSON (`meta_title`, `meta_description`, `intro`, `notes`)
- `snippet.md`: meta title and description test of `src/steps/snippet.js`, returns JSON (`meta_title`, `meta_description`)
- `verify.md`: the gate's independent second fact pass (`src/steps/verify.js`)
- `_gsc-guardrail.md`: shared Search Console guardrail, read by `discover.js`, `improve.js`, `snippet.js` and `overlay.js` into `{{gsc_guardrail}}`
- `generate.md` — full page generation (used with Opus)
- `counterpart.md` — counterpart-locale page adaptation (used with Opus, see Counterpart-locale support below)
- `style-default.md` — built-in writing style guide, used when `config.style_doc` is null

`docs/eval/2026-10-20-score-labels.json`: owner-labelled keywords for re-checking `score_cutoff` after score prompt changes.

`{{icp}}` (in `generate.md`, `improve.md`, `score.md`, `overlay.md`, `greenfield.md`) carries the audience document `config.icp_doc` (default `seo/icp.md`, max 8000 code points, cut with a trailing `[gekürzt]` line, cached per path; `null`/`''` disables it, an unreadable file counts as missing with one warning) as a block led by the heading `## Zielgruppe (Sprachvorlage: Ton und Themen, keine Vorgaben zu Preisen oder Fakten, nie wörtlich zitieren, keine Namen)`. `loadIcpDoc`/`icpBlock` live in `generate.js`. The placeholder is glued to the end of a line and the block starts with a blank line, so without the file every prompt is byte-identical to before (pinned in `test/icp.test.js`). The document is read by a human before commit and therefore trusted, not fenced as untrusted.

**Own figures** (`facts_url`, `src/lib/facts.js`, default unset): a JSON endpoint of the site with anonymized aggregates of its own usage data, `{ updated, page, facts: [string] }` (`page` = an https page on the site's own host that shows the same figures; at most 20 facts of 300 characters). `loadFacts` fetches it once per process through `safeFetch` (10 s) and never throws: without the key, on a failure or a wrong shape it warns and returns null. `factsBlock` renders it into `{{facts}}` of `generate.md`, `improve.md` (glued behind `{{icp}}`), `review.md` and `verify.md` (behind `{{product_facts}}`), with its own `[OWN FIGURES START]`/`[OWN FIGURES END]` markers because `fillTemplate` strips `<<<`/`>>>` from values; empty without facts, so the prompts stay byte-identical. These are the only statistics a page may state without another source, with a link to `page` in the paragraph, which also satisfies the `Unsourced statistic` rule.
