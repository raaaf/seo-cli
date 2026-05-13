import chalk from 'chalk';

export function validate(markdown, keyword) {
  const errors = [];
  const warnings = [];

  // Parse frontmatter
  const fmMatch = markdown.match(/^---\n([\s\S]+?)\n---/);
  if (!fmMatch) {
    errors.push('No YAML frontmatter found');
    return { ok: false, errors, warnings };
  }

  const body = markdown.slice(fmMatch[0].length).trim();
  const fm = fmMatch[1];

  // Required frontmatter fields
  for (const field of ['slug', 'metaTitle', 'metaDescription', 'type']) {
    if (!fm.includes(`${field}:`)) errors.push(`Missing frontmatter field: ${field}`);
  }

  // Meta title length
  const titleMatch = fm.match(/metaTitle:\s*["']?(.+?)["']?\s*$/m);
  if (titleMatch) {
    const len = titleMatch[1].length;
    if (len < 40) warnings.push(`metaTitle too short (${len} chars, aim for 50–60)`);
    if (len > 65) errors.push(`metaTitle too long (${len} chars, max 65)`);
  }

  // Meta description length
  const descMatch = fm.match(/metaDescription:\s*["']?(.+?)["']?\s*$/m);
  if (descMatch) {
    const len = descMatch[1].length;
    if (len < 120) warnings.push(`metaDescription short (${len} chars, aim for 140–160)`);
    if (len > 170) errors.push(`metaDescription too long (${len} chars, max 170)`);
  }

  // H1: either in body or in frontmatter hero.headline
  const bodyH1 = body.match(/^#\s+(.+)/m);
  const fmHeroHeadline = fm.match(/headline:\s*["']?(.+?)["']?\s*$/m);
  const h1Text = bodyH1?.[1] || fmHeroHeadline?.[1] || null;
  if (!h1Text) errors.push('No H1 found (neither # in body nor hero.headline in frontmatter)');

  // H1 contains keyword
  if (h1Text && !h1Text.toLowerCase().includes(keyword.keyword.toLowerCase().split(' ')[0])) {
    warnings.push(`H1 may not contain target keyword: "${h1Text}"`);
  }

  // Min word count
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 600) errors.push(`Too short: ${wordCount} words (min 600)`);

  // Keyword stuffing (> 4% density)
  const keywordCount = (body.toLowerCase().match(new RegExp(escapeRegex(keyword.keyword.toLowerCase()), 'g')) || []).length;
  const density = wordCount > 0 ? keywordCount / wordCount : 0;
  if (density > 0.04) errors.push(`Keyword stuffing: ${(density * 100).toFixed(1)}% density (max 4%)`);

  // Entity coverage
  const entities = keyword.expected_entities || [];
  if (entities.length > 0) {
    const bodyLower = body.toLowerCase();
    const missing = entities.filter(e => !bodyLower.includes(e.toLowerCase()));
    const coverage = (entities.length - missing.length) / entities.length;
    if (coverage < 0.7) {
      warnings.push(`Entity coverage ${(coverage * 100).toFixed(0)}% (aim for 70%+). Missing: ${missing.join(', ')}`);
    }
  }

  // FAQ section
  if (!body.match(/##.*(FAQ|Häufig|Fragen)/i)) {
    warnings.push('No FAQ section found');
  }

  const ok = errors.length === 0;

  if (!ok) {
    console.log(chalk.red(`  Validation failed:`));
    errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
  }
  if (warnings.length) {
    warnings.forEach(w => console.log(chalk.yellow(`    ⚠ ${w}`)));
  }
  if (ok) console.log(chalk.green(`  Validation passed (${wordCount} words, ${warnings.length} warnings)`));

  return { ok, errors, warnings };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
