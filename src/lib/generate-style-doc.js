import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { complete } from './claude.js';

export async function generateStyleDoc(siteUrl, outputPath, cwd = process.cwd()) {
  const pages = await fetchCopyHeavyPages(siteUrl);

  const styleGuide = await complete({
    system: 'You analyze website copy and derive a writing style guide. Write the guide in the same language as the website copy.',
    prompt: `Analyze the following website copy and derive a writing style guide.

${pages}

Create a Markdown document with this structure:

# Writing Style Guide

## Tone
(How does the site sound? Direct/casual/formal? Who is the audience?)

## Language
(You/Sie? Active/passive? Sentence length? Particularities?)

## Forbidden phrases
(At least 15 formulations that should NEVER appear and don't fit the style)

## Good examples
(3–5 real sentences from the copy that demonstrate the style well)

## Don't / Do
(3 side-by-side comparisons: generic text vs. how it would sound on this site)

## CTA style
(How are calls to action phrased? Examples.)

Be specific and concrete. No generic advice.`,
    maxTokens: 3000,
  });

  const fullPath = join(cwd, outputPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, styleGuide, 'utf8');

  return fullPath;
}

async function fetchCopyHeavyPages(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const candidates = [
    base,
    `${base}/preise`,
    `${base}/ueber-uns`,
    `${base}/about`,
    `${base}/features`,
    `${base}/hilfe`,
  ];

  const results = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const html = await res.text();
      const text = extractMainCopy(html);
      if (text.length > 200) results.push(`--- ${url} ---\n${text.slice(0, 1500)}`);
      if (results.length >= 3) break;
    } catch {}
  }

  return results.join('\n\n') || '(Keine Texte gefunden)';
}

function extractMainCopy(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
