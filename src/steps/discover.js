import { readFileSync } from 'fs';
import chalk from 'chalk';
import { querySearchAnalytics } from '../lib/gsc.js';
import { getSerp, checkQuota } from '../lib/serpapi.js';
import { complete } from '../lib/claude.js';
import { loadKeywords, saveKeywords, upsertKeyword, KEYWORD_STATUS } from '../lib/keywords.js';
import { format } from '../lib/date.js';
import { getExistingTitles, getExistingSlugs } from '../lib/landings.js';
import { fillTemplate } from '../lib/template.js';

const SCORE_PROMPT = readFileSync(new URL('../prompts/score.md', import.meta.url), 'utf8');
const GREENFIELD_PROMPT = readFileSync(new URL('../prompts/greenfield.md', import.meta.url), 'utf8');

export async function discover(config, cwd = process.cwd()) {
  console.log(chalk.blue('Discovering keywords...'));
  const quota = checkQuota();
  console.log(chalk.gray(`  SerpAPI: ${quota.used}/${quota.used + quota.remaining} used this week`));

  const data = loadKeywords(cwd);
  const existingSlugs = data.keywords.map(k => k.target_slug).filter(Boolean);
  const doneKeywords = new Set(
    data.keywords.filter(k => [KEYWORD_STATUS.DONE, KEYWORD_STATUS.SKIP, KEYWORD_STATUS.PR_OPENED].includes(k.status)).map(k => k.keyword)
  );

  // Mark as done any keywords whose file already exists locally (merged PR)
  const existingFiles = getExistingSlugs(config, cwd, config.locale);
  let markedDone = 0;
  for (const kw of data.keywords) {
    if (kw.status === KEYWORD_STATUS.PR_OPENED && kw.target_slug && existingFiles.includes(kw.target_slug)) {
      kw.status = KEYWORD_STATUS.DONE;
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
    await discoverGreenfield({ config, data, existingSlugs, cwd });
  } else {
    await scoreAndSave({ candidates, config, data, existingSlugs });
  }

  saveKeywords(data, cwd);
  const newCount = data.keywords.filter(k => k.status === KEYWORD_STATUS.PROPOSED).length;
  console.log(chalk.green(`  Discover done. ${newCount} keyword(s) proposed.`));

  return data;
}

function isSlugTaken(targetSlug, keyword, data) {
  return Boolean(targetSlug && data.keywords.some(k => k.target_slug === targetSlug && k.keyword !== keyword));
}

function buildKeywordEntry({ keyword, source, score, type, intent, target_slug, expected_entities, content_gaps, serp, gsc, scoreCutoff }) {
  if (score < scoreCutoff) {
    return { keyword, status: KEYWORD_STATUS.SKIP, score, discovered_at: format(new Date()) };
  }
  const entry = {
    keyword,
    status: KEYWORD_STATUS.PROPOSED,
    score,
    source,
    type,
    intent,
    target_slug,
    expected_entities: expected_entities || [],
    content_gaps: content_gaps || [],
    serp: { people_also_ask: serp.people_also_ask, related_searches: serp.related_searches },
    discovered_at: format(new Date()),
  };
  if (gsc) entry.gsc = gsc;
  return entry;
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

    if (!/^[a-z0-9][a-z0-9-]*$/.test(result.target_slug || '')) {
      console.log(chalk.yellow(`  Skipping invalid slug from Claude: ${JSON.stringify(result.target_slug)}`));
      continue;
    }

    if (isSlugTaken(result.target_slug, row.keyword, data)) {
      console.log(chalk.gray(`  Slug collision: ${result.target_slug} already taken, skipping ${row.keyword}`));
      continue;
    }

    upsertKeyword(data, buildKeywordEntry({
      keyword: row.keyword,
      source: 'gsc',
      score: result.score,
      type: result.type,
      intent: result.intent,
      target_slug: result.target_slug,
      expected_entities: result.expected_entities,
      content_gaps: result.content_gaps,
      serp: serpData,
      gsc: { impressions: row.impressions, position: row.position, clicks: row.clicks },
      scoreCutoff: config.score_cutoff,
    }));
    if (result.score >= config.score_cutoff) scored++;
    if (scored >= 10) break;
  }
}

async function discoverGreenfield({ config, data, existingSlugs, cwd }) {
  const existingLandings = getExistingTitles(config.landing_path, cwd);

  const prompt = fillTemplate(GREENFIELD_PROMPT, {
    clusters: (config.clusters || []).join(', '),
    existing_slugs: existingSlugs.join(', ') || 'none',
    existing_landings: existingLandings.join(', ') || 'none',
    locale: config.locale || 'de',
  });

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

  const serpResults = await Promise.all(
    keywords.map(async (kw) => {
      if (!kw.keyword) return null;
      try {
        return await getSerp(kw.keyword, { locale: config.locale });
      } catch (e) {
        console.log(chalk.yellow(`    SerpAPI skip (${kw.keyword}): ${e.message}`));
        return { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
      }
    })
  );

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    if (!kw.keyword) continue;

    if (!/^[a-z0-9][a-z0-9-]*$/.test(kw.target_slug || '')) {
      console.log(chalk.yellow(`  Skipping invalid slug from Claude: ${JSON.stringify(kw.target_slug)}`));
      continue;
    }

    const serpData = serpResults[i] || { top_titles: [], top_snippets: [], people_also_ask: [], related_searches: [] };
    console.log(chalk.gray(`    SerpAPI: ${serpData.people_also_ask.length} PAA, ${serpData.related_searches.length} related for "${kw.keyword}"`));

    upsertKeyword(data, buildKeywordEntry({
      keyword: kw.keyword,
      source: 'greenfield',
      score: kw.score ?? 7,
      type: kw.type,
      intent: kw.intent,
      target_slug: kw.target_slug,
      expected_entities: kw.expected_entities,
      content_gaps: kw.content_gaps,
      serp: serpData,
      scoreCutoff: config.score_cutoff,
    }));
  }
}

function buildScorePrompt(keyword, row, config, existingSlugs, serpData) {
  const vars = {
    keyword: String(keyword).replace(/[\r\n]+/g, ' ').slice(0, 200),
    impressions: row.impressions,
    position: row.position.toFixed(1),
    clicks: row.clicks,
    clusters: (config.clusters || []).join(', '),
    existing_slugs: existingSlugs.join(', ') || 'none',
    serp_titles: serpData.top_titles.join('\n') || 'n/a',
    serp_snippets: serpData.top_snippets.join('\n') || 'n/a',
    people_also_ask: serpData.people_also_ask.join('\n') || 'n/a',
    locale: config.locale || 'de',
  };
  return fillTemplate(SCORE_PROMPT, vars);
}

