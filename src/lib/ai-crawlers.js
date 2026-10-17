// AI crawler access: which bots we watch, what robots.txt says about them (RFC 9309) and whether a
// live fetch as the bot is turned away while a browser gets through. Pure, no I/O.

// `search`: alerts. `training`: report only. `live`: fetched as that UA. `robots`: judged against robots.txt;
// user-triggered fetchers (ChatGPT-User, Perplexity-User) are not, since the vendors do not apply it to them.
export const AI_BOTS = [
  { token: 'OAI-SearchBot', kind: 'search', live: true, robots: true },
  { token: 'PerplexityBot', kind: 'search', live: true, robots: true },
  { token: 'Claude-SearchBot', kind: 'search', live: true, robots: true },
  { token: 'Claude-User', kind: 'search', live: true, robots: true },
  { token: 'ChatGPT-User', kind: 'search', live: true, robots: false },
  { token: 'Perplexity-User', kind: 'search', live: true, robots: false },
  { token: 'GPTBot', kind: 'training', live: false, robots: true },
  { token: 'ClaudeBot', kind: 'training', live: false, robots: true },
  { token: 'CCBot', kind: 'training', live: false, robots: true },
  { token: 'Google-Extended', kind: 'training', live: false, robots: true },
];

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const botUserAgent = (token) => `Mozilla/5.0 (compatible; ${token}/1.0)`;

const MAX_ROBOTS_CHARS = 500 * 1024;

/**
 * Groups of a robots.txt: [{ agents: [lowercase], rules: [{ allow, path }] }]. Tolerates BOM, CRLF,
 * comments and lines before the first User-agent; unknown directives (Sitemap, Content-Signal, Crawl-delay) are ignored.
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  const body = String(text).slice(0, MAX_ROBOTS_CHARS);
  for (const raw of (body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((directive === 'allow' || directive === 'disallow') && current) {
      current.rules.push({ allow: directive === 'allow', path: value });
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Groups for a fetched robots.txt: any 4xx allows everything, 2xx is parsed, 5xx or no answer is unknown (null). */
export function robotsRules(status, text) {
  if (status >= 400 && status < 500) return [];
  if (status >= 200 && status < 300) return parseRobots(text);
  return null;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function matcher(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * 'allowed', 'blocked' or 'unknown' (groups null) for one bot token and path. The group whose User-agent equals the
 * token exactly (case-insensitive, no substring) wins over `*`; same-named groups merge; the longest matching
 * path decides and Allow wins a tie; an empty Disallow allows everything.
 */
export function robotsVerdict(groups, token, path) {
  if (!groups) return 'unknown';
  const named = groups.filter(g => g.agents.includes(token.toLowerCase()));
  const rules = (named.length ? named : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  const target = decode(path);
  let best = null;
  for (const rule of rules) {
    const pattern = decode(rule.path);
    if (!pattern || !matcher(pattern).test(target)) continue;
    if (!best || pattern.length > best.length || (pattern.length === best.length && rule.allow)) best = { length: pattern.length, allow: rule.allow };
  }
  return best && !best.allow ? 'blocked' : 'allowed';
}

/** Verdict over several paths: `{ verdict, paths }` with the blocked paths, sorted. */
export function robotsAccess(groups, token, paths) {
  const verdicts = paths.map(p => [p, robotsVerdict(groups, token, p)]);
  const blocked = verdicts.filter(([, v]) => v === 'blocked').map(([p]) => p).sort();
  if (blocked.length) return { verdict: 'blocked', paths: blocked };
  return { verdict: verdicts.some(([, v]) => v === 'unknown') ? 'unknown' : 'allowed', paths: [] };
}

/** A bot challenge page (Cloudflare) instead of the content. `headers` has lowercase keys. */
export function isChallenge({ headers = {}, html = '' }) {
  return headers['cf-mitigated'] === 'challenge' || html.includes('challenges.cloudflare.com') || /just a moment/i.test(html);
}

/**
 * One URL as the bot and as a browser (`{ status, headers, html }` or null when the fetch failed):
 * 'blocked' when the bot gets 4xx/5xx or a challenge while the browser gets 2xx, 'ok' when the bot gets through,
 * 'unknown' when the browser itself is turned away or either fetch failed.
 */
export function liveVerdict({ bot, browser }) {
  if (!bot || !browser || browser.status < 200 || browser.status >= 300 || isChallenge(browser)) return { verdict: 'unknown', status: null };
  if (bot.status >= 400 || isChallenge(bot)) return { verdict: 'blocked', status: bot.status };
  return { verdict: 'ok', status: bot.status };
}

/** Several URLs of one bot: blocked if any is, else ok if any is, else unknown. */
export function liveSummary(verdicts) {
  const blocked = verdicts.find(v => v.verdict === 'blocked');
  if (blocked) return blocked;
  return verdicts.find(v => v.verdict === 'ok') ?? { verdict: 'unknown', status: null };
}
