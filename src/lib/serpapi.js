export async function getSerp(keyword, { locale = 'de', gl = 'de' } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error('SERPAPI_KEY not set');

  const params = new URLSearchParams({
    q: keyword,
    hl: locale,
    gl,
    num: 10,
    api_key: process.env.SERPAPI_KEY,
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);

  const data = await res.json();
  const results = (data.organic_results || []).slice(0, 5);

  return {
    top_titles: results.map(r => r.title),
    top_snippets: results.map(r => r.snippet).filter(Boolean),
    related_searches: (data.related_searches || []).slice(0, 5).map(r => r.query),
    people_also_ask: (data.related_questions || []).slice(0, 4).map(r => r.question),
  };
}
