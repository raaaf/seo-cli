import chalk from 'chalk';
import { parseFrontmatter } from '../lib/frontmatter.js';

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
    if (len < 40) warnings.push(`meta_title short (${len} chars, aim 50–60)`);
    if (len > 65) errors.push(`meta_title too long (${len} chars, max 65)`);
  }

  // meta_description length
  if (parsed.meta_description != null) {
    const len = String(parsed.meta_description).length;
    if (len < 120) warnings.push(`meta_description short (${len} chars, aim 140–160)`);
    if (len > 170) errors.push(`meta_description too long (${len} chars, max 170)`);
  }

  // hero.headline exists and contains keyword
  const headline = parsed.hero?.headline;
  if (!headline) {
    errors.push('Missing hero.headline');
  } else if (!String(headline).toLowerCase().includes(keyword.keyword.toLowerCase().split(' ')[0])) {
    warnings.push(`hero.headline may not contain target keyword: "${headline}"`);
  }

  // faq has entries
  const faqCount = Array.isArray(parsed.faq) ? parsed.faq.length : 0;
  if (faqCount < 3) errors.push(`Too few FAQ entries (${faqCount}, min 3)`);

  // Body word count — must pass events app thin-content guard (>= 800)
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 800) errors.push(`Body too short: ${wordCount} words (min 800 — events app test requires this)`);
  if (wordCount > 1400) warnings.push(`Body very long: ${wordCount} words (aim 800–1200)`);

  // No steps/FAQ/checklist sections in body (those belong in frontmatter)
  if (body.match(/^#{1,3}\s.*(FAQ|Häufige|Checklist|Schritt|Step)/im)) {
    warnings.push('Body contains structured sections (FAQ/Steps/Checklist) — these should be in frontmatter');
  }

  // Keyword in body
  if (!body.toLowerCase().includes(keyword.keyword.toLowerCase().split(' ')[0])) {
    warnings.push(`Keyword "${keyword.keyword}" not found in body`);
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
    if (tldrWords < 40) errors.push(`tldr too short: ${tldrWords} words (min 40)`);
    if (tldrWords > 60) errors.push(`tldr too long: ${tldrWords} words (max 60)`);
  }

  // Information density: >= 5 digits in body
  const digitCount = (body.match(/\d/g) || []).length;
  if (digitCount < 5) errors.push(`Too few digits in body: ${digitCount} (min 5 — include concrete numbers)`);

  // Tonality: no em-dash, no double-hyphen separator, no emoji
  if (markdown.includes('—')) errors.push('Em-dash (—) found — use comma, colon or period');
  if (/(?<![-])\s--\s(?![-])/.test(markdown)) errors.push('Double-hyphen separator found — use em-dash alternative');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(markdown)) errors.push('Emoji found — remove all emoji');

  // No fabricated claims
  const fabricated = [
    /wir haben .{0,10}(kunden|paare|teams|nutzer|event)/i,
    /in den letzten .{0,5}jahren/i,
    /mehr als \d+ (kunden|paare|teams|nutzer)/i,
    /we (have )?helped .{0,20}customers/i,
    /over .{0,5}years of experience/i,
  ];
  for (const pattern of fabricated) {
    if (pattern.test(body)) {
      errors.push(`Fabricated claim detected: "${body.match(pattern)?.[0]}"`);
    }
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
