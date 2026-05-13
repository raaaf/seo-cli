import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { complete } from './claude.js';

export async function generateStyleDoc(siteUrl, outputPath, cwd = process.cwd()) {
  const pages = await fetchCopyHeavyPages(siteUrl);

  const styleGuide = await complete({
    system: 'Du analysierst Website-Texte und leitest daraus einen Schreibstil-Guide ab. Antworte auf Deutsch.',
    prompt: `Analysiere die folgenden Website-Texte und leite einen Schreibstil-Guide ab.

${pages}

Erstelle ein Markdown-Dokument mit diesem Aufbau:

# Schreibstil-Guide

## Tonalität
(Wie klingt die Seite? Direkt/locker/formal? Wer ist die Zielgruppe?)

## Sprache
(Du/Sie? Aktiv/Passiv? Satzlänge? Besonderheiten?)

## Verbotene Phrasen
(Mindestens 15 Formulierungen die auf dieser Seite NIE vorkommen und nicht zum Stil passen)

## Gute Beispiele
(3–5 echte Sätze aus den Texten die den Stil gut zeigen)

## So nicht / So ja
(3 Gegenüberstellungen: generischer Text vs. wie es auf dieser Website klingen würde)

## CTA-Stil
(Wie sind Handlungsaufforderungen formuliert? Beispiele.)

Sei konkret und spezifisch. Keine generischen Ratschläge.`,
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
