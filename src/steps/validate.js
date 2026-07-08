import chalk from 'chalk';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { SEO_THRESHOLDS } from '../lib/seo-thresholds.js';

const FABRICATED_PATTERNS = Object.freeze([
  /wir haben .{0,10}(kunden|paare|teams|nutzer|event)/i,
  /in den letzten .{0,5}jahren/i,
  /mehr als \d+ (kunden|paare|teams|nutzer)/i,
  /we (have )?helped .{0,20}customers/i,
  /over .{0,5}years of experience/i,
  // First-person consultant anecdotes / invented client stories
  /\b(in|aus) meiner praxis\b/i,
  /\bbaute ich\b/i,
  /\bein kunde (wollte|kam|bat|wünschte|fragte|brauchte)\b/i,
  /\bfür einen (kunden|auftraggeber)\b/i,
  /\bin (einem|meinem) (kunden|projekt)?projekt\b/i,
]);

// Recurring content slips the model reintroduces despite explicit prompt rules:
// anglicisms with established German equivalents, stale brand names, and outdated
// German tax thresholds. Surfaced as warnings (not gates) so they get caught in
// PR review. Extend as new slips recur (see seo-cli-content-review-patterns memory).
const CONTENT_DENYLIST = Object.freeze([
  { re: /\bedge[\s-]?cases?\b/i, msg: 'Anglicism "Edge Case(s)": use "Sonderfall/Randfall"' },
  { re: /\bcase stud(y|ies)\b/i, msg: 'Anglicism "Case Study/Studies": use "Fallstudie(n)"' },
  { re: /\blexoffice\b/i, msg: 'Stale brand "lexoffice": renamed to "Lexware Office" in 2024' },
  { re: /\b68\.?430\b/, msg: 'Stale 2025 tax value: 42% Grenzsteuersatz starts at 69.879 EUR in 2026, not 68.430' },
  { re: /\b11\.?604\b/, msg: 'Stale 2024 Grundfreibetrag 11.604: 2026 is ca. 12.348 EUR' },
  { re: /\b22\.?000\b.{0,20}\b50\.?000\b/, msg: 'Stale Kleinunternehmer thresholds 22.000/50.000: now 25.000/100.000' },
  {
    re: /(?:10[\s-]?jahren?|zehn jahren?)[\s\S]{0,120}?(?:auf\S{0,3}bewahr|archivier)|(?:auf\S{0,3}bewahr|archivier)[\s\S]{0,120}?(?:10[\s-]?jahren?|zehn jahren?)/i,
    msg: 'Stale Aufbewahrungsfrist "10 Jahre": Rechnungen/Buchungsbelege are 8 Jahre since 2025 (BEG IV)',
  },
  {
    re: /bruttoumsatz[\s\S]{0,400}?(?:kleinunternehmer|25\.000|100\.000)|(?:kleinunternehmer|25\.000|100\.000)[\s\S]{0,400}?bruttoumsatz/i,
    msg: 'Kleinunternehmer limits 25.000/100.000 EUR are net since 2025: write "Nettoumsatz", not "Bruttoumsatz"',
  },
]);

// Brands whose canonical casing the model often mangles. Warn on any occurrence
// that differs from the canonical form.
const BRAND_CASING = Object.freeze([
  'WordPress', 'JavaScript', 'TypeScript', 'GitHub', 'GitLab', 'PostgreSQL', 'macOS',
]);

export function validate(markdown, keyword) {
  const errors = [];
  const warnings = [];

  const { parsed, body, matched, error } = parseFrontmatter(markdown);
  if (!matched) {
    errors.push('No YAML frontmatter found');
    return { ok: false, errors, warnings };
  }
  if (error) {
    errors.push(`Frontmatter YAML parse error: ${error.message}`);
    return { ok: false, errors, warnings };
  }

  // Required frontmatter fields
  for (const field of ['slug', 'meta_title', 'meta_description', 'hero', 'tldr', 'faq']) {
    if (!(field in parsed)) errors.push(`Missing frontmatter field: ${field}`);
  }

  // meta_title length
  if (parsed.meta_title != null) {
    const len = String(parsed.meta_title).length;
    if (len < SEO_THRESHOLDS.metaTitle.shortWarn) warnings.push(`meta_title short (${len} chars, aim 50–60)`);
    if (len > SEO_THRESHOLDS.metaTitle.errorMax) errors.push(`meta_title too long (${len} chars, max 65)`);
  }

  // meta_description length
  if (parsed.meta_description != null) {
    const len = String(parsed.meta_description).length;
    if (len < SEO_THRESHOLDS.metaDescription.shortWarn) warnings.push(`meta_description short (${len} chars, aim 140–160)`);
    if (len > SEO_THRESHOLDS.metaDescription.errorMax) errors.push(`meta_description too long (${len} chars, max 170)`);
  }

  // hero.headline exists and contains the keyword (all significant tokens, not
  // just the first word — a multi-word keyword must not pass on one shared token)
  const headline = parsed.hero?.headline;
  if (!headline) {
    errors.push('Missing hero.headline');
  } else {
    const missing = missingKeywordTokens(String(headline), keyword.keyword);
    if (missing.length) warnings.push(`hero.headline may not contain target keyword (missing: ${missing.join(', ')}): "${headline}"`);
  }

  // faq has entries
  const faqCount = Array.isArray(parsed.faq) ? parsed.faq.length : 0;
  if (faqCount < SEO_THRESHOLDS.faqMin) errors.push(`Too few FAQ entries (${faqCount}, min 3)`);

  // Body word count — min 800 words (thin-content guard)
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < SEO_THRESHOLDS.bodyWords.errorMin) errors.push(`Body too short: ${wordCount} words (min 800)`);
  if (wordCount > SEO_THRESHOLDS.bodyWords.longWarn) warnings.push(`Body very long: ${wordCount} words (aim 800–1200)`);

  // No steps/FAQ/checklist sections in body (those belong in frontmatter)
  if (body.match(/^#{1,3}\s.*(FAQ|Häufige|Checklist|Schritt|Step)/im)) {
    warnings.push('Body contains structured sections (FAQ/Steps/Checklist) — these should be in frontmatter');
  }

  // Keyword in body (all significant tokens)
  const missingInBody = missingKeywordTokens(body, keyword.keyword);
  if (missingInBody.length) {
    warnings.push(`Keyword "${keyword.keyword}" not fully present in body (missing: ${missingInBody.join(', ')})`);
  }

  // Stuffing check
  const keywordCount = (body.toLowerCase().match(new RegExp(escapeRegex(keyword.keyword.toLowerCase()), 'g')) || []).length;
  const density = wordCount > 0 ? keywordCount / wordCount : 0;
  if (density > 0.04) errors.push(`Keyword stuffing: ${(density * 100).toFixed(1)}% density (max 4%)`);

  // Entity coverage
  const entities = keyword.expected_entities || [];
  if (entities.length > 0) {
    const fullText = (JSON.stringify(parsed) + '\n' + body).toLowerCase();
    const missing = entities.filter(e => !fullText.includes(e.toLowerCase()));
    const coverage = (entities.length - missing.length) / entities.length;
    if (coverage < 0.6) {
      warnings.push(`Entity coverage ${(coverage * 100).toFixed(0)}% (aim 70%+). Missing: ${missing.join(', ')}`);
    }
  }

  // tldr word count (40–60 words)
  if (parsed.tldr != null) {
    const tldrWords = String(parsed.tldr).split(/\s+/).filter(Boolean).length;
    if (tldrWords < SEO_THRESHOLDS.tldrWords.errorMin) errors.push(`tldr too short: ${tldrWords} words (min 40)`);
    if (tldrWords > SEO_THRESHOLDS.tldrWords.errorMax) errors.push(`tldr too long: ${tldrWords} words (max 60)`);
  }

  // Information density: >= 5 digits in body
  const digitCount = (body.match(/\d/g) || []).length;
  if (digitCount < 5) errors.push(`Too few digits in body: ${digitCount} (min 5 — include concrete numbers)`);

  // Tonality: no em-dash, no double-hyphen separator, no emoji
  if (markdown.includes('—')) errors.push('Em-dash (—) found — use comma, colon or period');
  if (/(?<![-])\s--\s(?![-])/.test(markdown)) errors.push('Double-hyphen separator found — use em-dash alternative');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(markdown)) errors.push('Emoji found — remove all emoji');

  // No fabricated claims
  for (const pattern of FABRICATED_PATTERNS) {
    if (pattern.test(body)) {
      errors.push(`Fabricated claim detected: "${body.match(pattern)?.[0]}"`);
    }
  }

  // Recurring content slips (anglicisms, stale brands/facts). Scan frontmatter +
  // body so issues inside FAQ/meta fields are caught too. Strip URLs, relative
  // link targets, and slug tokens first so lowercase brand names inside links
  // or internal-link slugs (e.g. .../cm-wordpress, /wordpress-website-erstellen-lassen,
  // a related_pages slug entry) don't trip the casing/denylist checks.
  const fullScan = (JSON.stringify(parsed) + '\n' + body)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\]\(\/[^)]*\)/g, '')
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g, '');
  for (const { re, msg } of CONTENT_DENYLIST) {
    const m = fullScan.match(re);
    if (m) warnings.push(`${msg} (found "${m[0].trim()}")`);
  }

  // Brand casing: flag any non-canonical spelling of a known brand
  for (const canonical of BRAND_CASING) {
    const found = fullScan.match(new RegExp(`\\b${escapeRegex(canonical)}\\b`, 'gi')) || [];
    const wrong = found.find(f => f !== canonical);
    if (wrong) warnings.push(`Brand casing: write "${canonical}", not "${wrong}"`);
  }

  // Weak citations: markdown links to bare homepages used as evidence
  const homepageCites = body.match(/\]\(https?:\/\/[^/)]+\/?\)/g) || [];
  for (const cite of homepageCites) {
    warnings.push(`Homepage-only citation (link deep or drop it): ${cite}`);
  }

  const ok = errors.length === 0;

  if (!ok) {
    console.log(chalk.red('  Validation failed:'));
    errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
  }
  warnings.forEach(w => console.log(chalk.yellow(`    ⚠ ${w}`)));
  if (ok) console.log(chalk.green(`  Validation passed (${wordCount} body words, ${faqCount} FAQ, ${warnings.length} warnings)`));

  return { ok, errors, warnings };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tokens of `keyword` (lowercased) not present in `text`. Considers tokens of
// 4+ chars to skip short stop-words; falls back to all tokens when none qualify.
function missingKeywordTokens(text, keyword) {
  const tokens = String(keyword).toLowerCase().split(/\s+/).filter(Boolean);
  const significant = tokens.filter(t => t.length >= 4);
  const check = significant.length ? significant : tokens;
  const haystack = String(text).toLowerCase();
  return check.filter(t => !haystack.includes(t));
}
