import { complete } from './claude.js';

export async function analyzeSite(url) {
  // Fetch homepage + a few key pages
  const pages = await fetchPages(url);

  const result = await complete({
    system: 'Du analysierst Websites und antwortest ausschließlich mit JSON.',
    prompt: `Analysiere diese Website und extrahiere die folgenden Informationen.

URL: ${url}

Seiten-Inhalt:
${pages}

Antworte mit diesem JSON:
\`\`\`json
{
  "topic": "1–2 Sätze was diese Website macht und für wen",
  "clusters": ["cluster 1", "cluster 2", "cluster 3"],
  "primary_cta": "trial_signup | book_demo | contact | download_app | learn_more",
  "locale": "de | en",
  "tone": "direkt und nüchtern | freundlich und locker | professionell und formal"
}
\`\`\`

Erlaubte primary_cta Werte: trial_signup, book_demo, contact, download_app, learn_more
Clusters: 3–5 prägnante Themen (2–4 Wörter), die beschreiben wofür Landing-Pages Sinn machen.`,
    json: true,
  });

  return result;
}

async function fetchPages(baseUrl) {
  const urls = [baseUrl, `${baseUrl.replace(/\/$/, '')}/preise`, `${baseUrl.replace(/\/$/, '')}/ueber-uns`];
  const results = [];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const html = await res.text();
      const text = stripHtml(html).slice(0, 2000);
      if (text.trim()) results.push(`--- ${url} ---\n${text}`);
    } catch {}
  }

  return results.join('\n\n') || '(Seite nicht erreichbar)';
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
