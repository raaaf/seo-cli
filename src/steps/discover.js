import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { querySearchAnalytics } from '../lib/gsc.js';
import { getSerp, checkQuota } from '../lib/serpapi.js';
import { complete } from '../lib/claude.js';
import { loadKeywords, saveKeywords, upsertKeyword } from '../lib/keywords.js';

const SCORE_PROMPT = readFileSync(new URL('../prompts/score.md', import.meta.url), 'utf8');
const GREENFIELD_PROMPT = readFileSync(new URL('../prompts/greenfield.md', import.meta.url), 'utf8');

export async function discover(config, cwd = process.cwd()) {
  console.log(chalk.blue('Discovering keywords...'));
  const quota = checkQuota();
  console.log(chalk.gray(`  SerpAPI: ${quota.used}/${quota.used + quota.remaining} used this week`));

  const data = loadKeywords(cwd);
  const existingSlugs = data.keywords.map(k => k.target_slug).filter(Boolean);
  const doneKeywords = new Set(
    data.keywords.filter(k => ['done', 'skip', 'pr_opened'].includes(k.status)).map(k => k.keyword)
  );

  // Mark as done any keywords whose file already exists locally (merged PR)
  const existingFiles = getExistingLandingTitles(config.landing_path, cwd);
  let markedDone = 0;
  for (const kw of data.keywords) {
    if (kw.status === 'pr_opened' && kw.target_slug && existingFiles.includes(kw.target_slug)) {
      kw.status = 'done';
      markedDone++;
    }
  }
  if (markedDone > 0) console.log(chalk.gray(`  Marked ${markedDone} keyword(s) as done (files found locally)`));

  const rows = await querySearchAnalytics(config.gsc_property);
  const minImpressions = config.min_impressions ?? 5;
  const candidates = rows.filter(
    r => r.position >= 8 && r.position <= 25 && r.impressions >= minImpressions && !doneKeywords.has(r.keyword)
  );

  if (rows.length > 0) {
    console.log(chalk.gray(`  GSC data (top ${rows.length} queries):`));
    rows.slice(0, 10).forEach(r =>
      console.log(chalk.gray(`    pos ${r.position.toFixed(1).padStart(5)}  impr ${String(r.impressions).padStart(4)}  "${r.keyword}"`))
    );
  }
  console.log(chalk.gray(`  ${candidates.length} GSC candidates (pos 8–25, impr >= ${minImpressions})`));

  // Greenfield fallback: when GSC has no usable data
  const useGreenfield = candidates.length === 0;
  if (useGreenfield) {
    console.log(chalk.yellow('  GSC data too sparse — switching to greenfield mode.'));
    await discoverGreenfield({ config, data, existingSlugs, doneKeywords, cwd });
  } else {
    await scoreAndSave({ candidates, config, data, existingSlugs });
  }

  saveKeywords(data, cwd);
  const newCount = data.keywords.filter(k => k.status === 'proposed').length;
  console.log(chalk.green(`  Discover done. ${newCount} keyword(s) proposed.`));

  return data;
}

async function scoreAndSave({ candidates, config, data, existingSlugs }) {
  let scored = 0;
  for (const row of candidates.slice(0, 20)) {
    const existing = data.keywords.find(k => k.keyword === row.keyword);
    if (existing?.score != null) continue;

    let serpData = { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
    try {
      serpData = await getSerp(row.keyword, { locale: config.locale });
    } catch (e) {
      console.log(chalk.yellow(`  SerpAPI skip (${row.keyword}): ${e.message}`));
    }

    const prompt = buildScorePrompt(row.keyword, row, config, existingSlugs, serpData);
    let result;
    try {
      result = await complete({ system: 'You are an SEO expert. Reply exclusively with JSON.', prompt, json: true });
    } catch (e) {
      console.log(chalk.yellow(`  Score skip (${row.keyword}): ${e.message}`));
      continue;
    }

    // Skip if slug already taken by another keyword
    const slugTaken = result.target_slug &&
      data.keywords.some(k => k.target_slug === result.target_slug && k.keyword !== row.keyword);
    if (slugTaken) {
      console.log(chalk.gray(`  Slug collision: ${result.target_slug} already taken, skipping ${row.keyword}`));
      continue;
    }

    upsertKeyword(data, result.score < config.score_cutoff
      ? { keyword: row.keyword, status: 'skip', score: result.score, discovered_at: today() }
      : {
          keyword: row.keyword, status: 'proposed', score: result.score,
          source: 'gsc', type: result.type, intent: result.intent,
          target_slug: result.target_slug, expected_entities: result.expected_entities,
          content_gaps: result.content_gaps,
          serp: { people_also_ask: serpData.people_also_ask, related_searches: serpData.related_searches },
          gsc: { impressions: row.impressions, position: row.position, clicks: row.clicks },
          discovered_at: today(),
        }
    );
    if (result.score >= config.score_cutoff) scored++;
    if (scored >= 10) break;
  }
}

async function discoverGreenfield({ config, data, existingSlugs, cwd }) {
  const existingLandings = getExistingLandingTitles(config.landing_path, cwd);

  const prompt = GREENFIELD_PROMPT
    .replace('{{clusters}}', (config.clusters || []).join(', '))
    .replace('{{existing_slugs}}', existingSlugs.join(', ') || 'none')
    .replace('{{existing_landings}}', existingLandings.join(', ') || 'none')
    .replace('{{locale}}', config.locale || 'de');

  let suggestions;
  try {
    suggestions = await complete({
      system: 'You are an SEO expert. Reply exclusively with JSON.',
      prompt,
      json: true,
    });
  } catch (e) {
    console.log(chalk.red(`  Greenfield failed: ${e.message}`));
    return;
  }

  const keywords = Array.isArray(suggestions) ? suggestions : suggestions.keywords || [];
  console.log(chalk.gray(`  Greenfield: ${keywords.length} suggestions from Claude`));

  for (const kw of keywords) {
    if (!kw.keyword) continue;

    let serpData = { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
    try {
      serpData = await getSerp(kw.keyword, { locale: config.locale });
      console.log(chalk.gray(`    SerpAPI: ${serpData.people_also_ask.length} PAA, ${serpData.related_searches.length} related for "${kw.keyword}"`));
    } catch (e) {
      console.log(chalk.yellow(`    SerpAPI skip (${kw.keyword}): ${e.message}`));
    }

    upsertKeyword(data, {
      keyword: kw.keyword,
      status: 'proposed',
      score: kw.score ?? 7,
      source: 'greenfield',
      type: kw.type,
      intent: kw.intent,
      target_slug: kw.target_slug,
      expected_entities: kw.expected_entities || [],
      content_gaps: kw.content_gaps || [],
      serp: { people_also_ask: serpData.people_also_ask, related_searches: serpData.related_searches },
      discovered_at: today(),
    });
  }
}

function getExistingLandingTitles(landingPath, cwd) {
  try {
    const dir = join(cwd, landingPath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          const content = readFileSync(join(dir, f), 'utf8');
          const headlineMatch = content.match(/headline:\s*["']?(.+?)["']?\s*$/m);
          if (headlineMatch) return headlineMatch[1].trim();
        } catch {}
        return f.replace('.md', '');
      });
  } catch {
    return [];
  }
}

function buildScorePrompt(keyword, row, config, existingSlugs, serpData) {
  return SCORE_PROMPT
    .replace('{{keyword}}', keyword)
    .replace('{{impressions}}', row.impressions)
    .replace('{{position}}', row.position.toFixed(1))
    .replace('{{clicks}}', row.clicks)
    .replace('{{clusters}}', (config.clusters || []).join(', '))
    .replace('{{existing_slugs}}', existingSlugs.join(', ') || 'none')
    .replace('{{serp_titles}}', serpData.top_titles.join('\n') || 'n/a')
    .replace('{{serp_snippets}}', serpData.top_snippets.join('\n') || 'n/a')
    .replace('{{people_also_ask}}', serpData.people_also_ask.join('\n') || 'n/a')
    .replace('{{locale}}', config.locale || 'de');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
