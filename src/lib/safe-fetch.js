import { lookup } from 'dns/promises';
import { Agent } from 'undici';

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
  /^::$/,
];

// IPv4-mapped IPv6 (::ffff:10.0.0.1 or the hex form ::ffff:a00:1) is judged by its IPv4 part.
function unmapIPv4(ip) {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return ip;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPrivateAddress(ip) {
  const addr = unmapIPv4(ip);
  return PRIVATE_RANGES.some(rx => rx.test(addr));
}

// URL.hostname keeps the brackets of an IPv6 literal; dns.lookup wants them stripped.
function bareHost(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

// Lookup for the connection that always answers with the already validated addresses, so a
// second DNS answer cannot redirect the socket. Host header and SNI stay the hostname.
export function pinnedLookup(addresses) {
  return (_hostname, options, cb) => {
    const list = addresses.map(a => ({ address: a.address, family: a.family }));
    if (options?.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
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
  const host = bareHost(url);
  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${url.hostname}: ${e.message}`, { cause: e });
  }
  for (const r of resolved) {
    if (isPrivateAddress(r.address)) {
      throw new Error(`Refusing to fetch private/internal address: ${url.hostname} -> ${r.address}`);
    }
  }
  return resolved;
}

// The validated addresses are pinned for the actual connection (also per redirect hop), so
// DNS rebinding between validation and connect cannot reach an internal address.

export async function safeFetch(rawUrl, opts = {}) {
  const MAX_REDIRECTS = 5;
  let currentUrl = rawUrl;
  let redirectCount = 0;

  while (true) {
    const resolved = await assertPublicUrl(currentUrl);
    // Not closed here: the caller still reads the body. Idle sockets expire after 1 s.
    const dispatcher = new Agent({ keepAliveTimeout: 1000, connect: { lookup: pinnedLookup(resolved) } });
    const res = await fetch(currentUrl, { ...opts, redirect: 'manual', dispatcher });

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
