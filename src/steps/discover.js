import { readFileSync } from 'fs';
import chalk from 'chalk';
import { querySearchAnalytics } from '../lib/gsc.js';
import { getSerp } from '../lib/serpapi.js';
import { complete } from '../lib/claude.js';
import { loadKeywords, saveKeywords, upsertKeyword } from '../lib/keywords.js';

const SCORE_PROMPT = readFileSync(new URL('../prompts/score.md', import.meta.url), 'utf8');

export async function discover(config, cwd = process.cwd()) {
  console.log(chalk.blue('Discovering keywords...'));

  const data = loadKeywords(cwd);
  const existingSlugs = data.keywords.map(k => k.target_slug).filter(Boolean);
  const doneKeywords = new Set(data.keywords.filter(k => ['done', 'skip', 'pr_opened'].includes(k.status)).map(k => k.keyword));

  // GSC: position 8–25, min 100 impressions
  const rows = await querySearchAnalytics(config.gsc_property);
  const candidates = rows.filter(
    r => r.position >= 8 && r.position <= 25 && r.impressions >= 100 && !doneKeywords.has(r.keyword)
  );

  console.log(chalk.gray(`  GSC: ${rows.length} queries, ${candidates.length} candidates`));

  let scored = 0;
  for (const row of candidates.slice(0, 20)) {
    // Skip if already proposed with a score
    const existing = data.keywords.find(k => k.keyword === row.keyword);
    if (existing?.score != null) continue;

    let serpData = { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
    try {
      serpData = await getSerp(row.keyword, { locale: config.locale });
    } catch (e) {
      console.log(chalk.yellow(`  SerpAPI skip (${row.keyword}): ${e.message}`));
    }

    const prompt = SCORE_PROMPT
      .replace('{{keyword}}', row.keyword)
      .replace('{{impressions}}', row.impressions)
      .replace('{{position}}', row.position.toFixed(1))
      .replace('{{clicks}}', row.clicks)
      .replace('{{clusters}}', (config.clusters || []).join(', '))
      .replace('{{existing_slugs}}', existingSlugs.join(', ') || 'keine')
      .replace('{{serp_titles}}', serpData.top_titles.join('\n') || 'n/a')
      .replace('{{serp_snippets}}', serpData.top_snippets.join('\n') || 'n/a')
      .replace('{{people_also_ask}}', serpData.people_also_ask.join('\n') || 'n/a');

    let result;
    try {
      result = await complete({
        system: 'Du bist ein SEO-Experte. Antworte ausschließlich mit JSON.',
        prompt,
        json: true,
      });
    } catch (e) {
      console.log(chalk.yellow(`  Score skip (${row.keyword}): ${e.message}`));
      continue;
    }

    if (result.score < config.score_cutoff) {
      upsertKeyword(data, { keyword: row.keyword, status: 'skip', score: result.score, discovered_at: new Date().toISOString().slice(0, 10) });
    } else {
      upsertKeyword(data, {
        keyword: row.keyword,
        status: 'proposed',
        score: result.score,
        type: result.type,
        intent: result.intent,
        target_slug: result.target_slug,
        expected_entities: result.expected_entities,
        content_gaps: result.content_gaps,
        serp: {
          people_also_ask: serpData.people_also_ask,
          related_searches: serpData.related_searches,
        },
        gsc: { impressions: row.impressions, position: row.position, clicks: row.clicks },
        discovered_at: new Date().toISOString().slice(0, 10),
      });
      scored++;
    }

    // Respect weekly SerpAPI budget
    if (scored >= 10) break;
  }

  saveKeywords(data, cwd);
  console.log(chalk.green(`  Discover done. ${scored} new keywords proposed.`));

  return data;
}
