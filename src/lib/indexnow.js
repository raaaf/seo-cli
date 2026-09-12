export function extractSitemapUrls(xml) {
  const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
  return Array.from(matches, (m) => m[1]);
}

export async function fetchSitemapUrls(baseUrl, fetchImpl = fetch) {
  const base = baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/sitemap.xml`);
  const xml = await res.text();
  return extractSitemapUrls(xml);
}

export async function submitIndexNow({
  baseUrl,
  key,
  urls,
  fetchImpl = fetch,
  endpoint = 'https://api.indexnow.org/indexnow',
}) {
  const base = baseUrl.replace(/\/$/, '');
  const host = new URL(baseUrl).host;
  const body = {
    host,
    key,
    keyLocation: `${base}/${key}.txt`,
    urlList: urls,
  };

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });

  if (res.status !== 200 && res.status !== 202) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`IndexNow returned ${res.status}: ${text}`);
  }

  return { status: res.status, ok: true };
}
