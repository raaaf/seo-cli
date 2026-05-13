import { complete } from './claude.js';

export async function analyzeSite(url) {
  // Fetch homepage + a few key pages
  const pages = await fetchPages(url);

  const result = await complete({
    system: 'You analyze websites and reply exclusively with JSON.',
    prompt: `Analyze this website and extract the following information.

URL: ${url}

Page content:
${pages}

Reply with this JSON:
\`\`\`json
{
  "topic": "1–2 sentences describing what this site does and for whom",
  "clusters": ["cluster 1", "cluster 2", "cluster 3"],
  "primary_cta": "trial_signup | book_demo | contact | download_app | learn_more",
  "locale": "de | en",
  "tone": "direct and no-nonsense | friendly and casual | professional and formal"
}
\`\`\`

Allowed primary_cta values: trial_signup, book_demo, contact, download_app, learn_more
Clusters: 3–5 concise topics (2–4 words) describing what landing pages make sense for.`,
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
