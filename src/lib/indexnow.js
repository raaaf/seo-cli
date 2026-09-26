export function extractSitemapUrls(xml) {
  const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
  return Array.from(matches, (m) => m[1]);
}

export async function fetchSitemapUrls(baseUrl, fetchImpl = fetch, locale) {
  const base = baseUrl.replace(/\/$/, '');
  // Some sitemaps (e.g. zeit) localize their URL set by Accept-Language;
  // undici's fetch defaults to "*", which some of these servers treat as
  // English and drop non-English landing pages from. Send the project's
  // locale explicitly so we get the full URL set.
  const headers = locale ? { 'Accept-Language': locale } : undefined;
  const res = await fetchImpl(`${base}/sitemap.xml`, headers ? { headers } : undefined);
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
