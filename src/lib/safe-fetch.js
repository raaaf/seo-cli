import { lookup } from 'dns/promises';

const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isPrivateAddress(ip) {
  return PRIVATE_RANGES.some(rx => rx.test(ip));
}

export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Disallowed protocol: ${url.protocol}`);
  }
  if (url.hostname === 'localhost' || url.hostname === '0.0.0.0') {
    throw new Error(`Disallowed host: ${url.hostname}`);
  }
  let resolved;
  try {
    resolved = await lookup(url.hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${url.hostname}: ${e.message}`);
  }
  for (const r of resolved) {
    if (isPrivateAddress(r.address)) {
      throw new Error(`Refusing to fetch private/internal address: ${url.hostname} -> ${r.address}`);
    }
  }
}

// Known limitation: assertPublicUrl resolves DNS once before fetch(), which does its own
// DNS resolution. A TTL-0 DNS rebind attack between the two calls could redirect to a
// private IP. Acceptable for a CLI used against user-configured URLs in seo.config.yaml.

export async function safeFetch(rawUrl, opts = {}) {
  const MAX_REDIRECTS = 5;
  let currentUrl = rawUrl;
  let redirectCount = 0;

  while (true) {
    await assertPublicUrl(currentUrl);
    const res = await fetch(currentUrl, { ...opts, redirect: 'manual' });

    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect || !res.headers.get('location')) {
      return res;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) from ${rawUrl}`);
    }

    currentUrl = new URL(res.headers.get('location'), currentUrl).href;
    redirectCount++;
  }
}
