import { readFileSync } from 'fs';
import { complete } from '../lib/claude.js';
import { MODELS } from '../lib/models.js';
import { fillTemplate } from '../lib/template.js';

const PROMPT = readFileSync(new URL('../prompts/link-judge.md', import.meta.url), 'utf8');
const JSON_RETRY = 'Your last answer was not valid JSON. Answer with the JSON object only, no prose, no code fence.';
const MAX_REASON_WORDS = 8;

// The two parse failures thrown by claude.js when json is requested.
const isNoJsonError = (e) => /^Claude returned (no|malformed) JSON/.test(e?.message ?? '');

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseJudgments(parsed, known) {
  const list = Array.isArray(parsed) ? parsed : parsed?.judgments;
  if (!Array.isArray(list)) throw new Error('Claude returned malformed JSON: no judgments list');
  const seen = new Set();
  const out = [];
  for (const j of list) {
    if (!known.has(j?.slug) || seen.has(j.slug) || typeof j.score !== 'number') continue;
    seen.add(j.slug);
    out.push({ slug: j.slug, score: j.score, reason: oneLine(j.reason).split(' ').slice(0, MAX_REASON_WORDS).join(' ') });
  }
  return out;
}

/**
 * Which of `candidates` (`[{ slug, title, description }]`, already eligible) are on the same topic
 * as `target` (`{ slug, title, description }`)? One Haiku call per target, topic only: the model
 * scores 0 unrelated, 1 adjacent, 2 same need; code keeps the 2s in input order and takes `max`.
 * Slugs the model invents are dropped. Invalid JSON gets one retry, then no links and a warning
 * (`onWarning`). Returns `[{ slug, reason }]`; other failures (budget, transport) throw.
 */
export async function judgeLinkSources({ target, candidates, max = 3 }, onWarning = () => {}) {
  if (!candidates.length) return [];
  const line = (p) => `${p.slug} | ${oneLine(p.title)} | ${oneLine(p.description)}`;
  const prompt = fillTemplate(PROMPT, { target: line(target), candidates: candidates.map(line).join('\n') });
  const known = new Set(candidates.map(c => c.slug));
  const request = async (text) => parseJudgments(await complete({
    system: 'You judge whether two web pages cover the same topic for the same reader. You answer in JSON only.',
    prompt: text, model: MODELS.judge, maxTokens: 2048, json: true,
  }), known);

  let judgments;
  try {
    try {
      judgments = await request(prompt);
    } catch (e) {
      if (!isNoJsonError(e)) throw e;
      judgments = await request(`${prompt}\n\n${JSON_RETRY}`);
    }
  } catch (e) {
    if (!isNoJsonError(e)) throw e;
    onWarning(`Link judge for ${target.slug} returned no usable JSON twice, no links added`);
    return [];
  }

  const score = new Map(judgments.map(j => [j.slug, j]));
  return candidates
    .filter(c => score.get(c.slug)?.score === 2)
    .slice(0, max)
    .map(c => ({ slug: c.slug, reason: score.get(c.slug).reason }));
}
