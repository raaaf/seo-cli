import { describe, it, expect } from 'vitest';
import { parseRobots, robotsRules, robotsVerdict, robotsAccess, isChallenge, liveVerdict, liveSummary, botUserAgent } from '../src/lib/ai-crawlers.js';

const verdict = (text, token, path = '/') => robotsVerdict(parseRobots(text), token, path);

describe('robots.txt (RFC 9309)', () => {
  it('prefers the group of the exact token over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n';
    expect(verdict(txt, 'OAI-SearchBot')).toBe('allowed');
    expect(verdict(txt, 'PerplexityBot')).toBe('blocked');
  });

  it('matches the token case-insensitively but never as a substring', () => {
    const txt = 'User-agent: Claude\nDisallow: /\n';
    expect(verdict(txt, 'Claude-User')).toBe('allowed');
    expect(verdict('User-agent: claude-user\nDisallow: /\n', 'Claude-User')).toBe('blocked');
  });

  it('merges groups of the same name and shared User-agent lines', () => {
    const txt = 'User-agent: GPTBot\nDisallow: /a\n\nUser-agent: CCBot\nUser-agent: GPTBot\nDisallow: /b\n';
    expect(verdict(txt, 'GPTBot', '/a/x')).toBe('blocked');
    expect(verdict(txt, 'GPTBot', '/b')).toBe('blocked');
    expect(verdict(txt, 'CCBot', '/a')).toBe('allowed');
    expect(verdict(txt, 'CCBot', '/b')).toBe('blocked');
  });

  it('lets the longest matching path win and Allow win a tie', () => {
    const txt = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /same\nAllow: /same\n';
    expect(verdict(txt, 'X', '/docs/private')).toBe('blocked');
    expect(verdict(txt, 'X', '/docs/public/a')).toBe('allowed');
    expect(verdict(txt, 'X', '/same')).toBe('allowed');
  });

  it('supports * and $', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/secret\n';
    expect(verdict(txt, 'X', '/a/b.pdf')).toBe('blocked');
    expect(verdict(txt, 'X', '/a/b.pdf?x=1')).toBe('allowed');
    expect(verdict(txt, 'X', '/private-area/secret')).toBe('blocked');
  });

  it('compares percent-decoded paths', () => {
    expect(verdict('User-agent: *\nDisallow: /caf%C3%A9\n', 'X', '/café')).toBe('blocked');
    expect(verdict('User-agent: *\nDisallow: /café\n', 'X', '/caf%C3%A9')).toBe('blocked');
  });

  it('treats an empty Disallow as allow all', () => {
    expect(verdict('User-agent: *\nDisallow:\n', 'X', '/anything')).toBe('allowed');
  });

  it('ignores unknown directives, comments, BOM, CRLF and lines before the first User-agent', () => {
    const txt = '﻿Disallow: /orphan\r\nSitemap: https://a.de/s.xml\r\nUser-agent: * # everyone\r\nContent-Signal: ai-train=no\r\nCrawl-delay: 5\r\nDisallow: /x # comment\r\n';
    expect(verdict(txt, 'X', '/orphan')).toBe('allowed');
    expect(verdict(txt, 'X', '/x')).toBe('blocked');
  });

  it('reads any 4xx as allow all and 5xx or no answer as unknown', () => {
    expect(robotsVerdict(robotsRules(401, ''), 'X', '/')).toBe('allowed');
    expect(robotsVerdict(robotsRules(404, ''), 'X', '/')).toBe('allowed');
    expect(robotsVerdict(robotsRules(503, ''), 'X', '/')).toBe('unknown');
    expect(robotsVerdict(robotsRules(null, ''), 'X', '/')).toBe('unknown');
  });

  it('ends a run of User-agent lines at any other directive, Crawl-delay included', () => {
    const groups = parseRobots('User-agent: a\nCrawl-delay: 5\nUser-agent: b\nDisallow: /\n');
    expect(robotsVerdict(groups, 'a', '/')).toBe('allowed');
    expect(robotsVerdict(groups, 'b', '/')).toBe('blocked');
  });

  it('collects the blocked paths over several paths', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /b\nDisallow: /a\n');
    expect(robotsAccess(groups, 'X', ['/', '/b/x', '/a/y'])).toEqual({ verdict: 'blocked', paths: ['/a/y', '/b/x'] });
    expect(robotsAccess(groups, 'X', ['/'])).toEqual({ verdict: 'allowed', paths: [] });
    expect(robotsAccess(null, 'X', ['/'])).toEqual({ verdict: 'unknown', paths: [] });
  });
});

describe('live verdict', () => {
  const res = (status, extra = {}) => ({ status, headers: {}, html: '<html>ok</html>', ...extra });

  it('blocks on 402 (pay per crawl) and on other 4xx/5xx while the browser gets 2xx', () => {
    expect(liveVerdict({ bot: res(402), browser: res(200) })).toEqual({ verdict: 'blocked', status: 402 });
    expect(liveVerdict({ bot: res(503), browser: res(200) })).toEqual({ verdict: 'blocked', status: 503 });
  });

  it('blocks on a challenge header and on challenge HTML', () => {
    expect(isChallenge({ headers: { 'cf-mitigated': 'challenge' }, html: '' })).toBe(true);
    expect(liveVerdict({ bot: res(200, { headers: { 'cf-mitigated': 'challenge' } }), browser: res(200) }).verdict).toBe('blocked');
    expect(liveVerdict({ bot: res(403, { html: '<title>Just a moment...</title>' }), browser: res(200) }).verdict).toBe('blocked');
    expect(liveVerdict({ bot: res(503, { html: '<script src="https://challenges.cloudflare.com/x"></script>' }), browser: res(200) }).verdict).toBe('blocked');
    expect(isChallenge({ status: 403, headers: {}, html: '<title>Just a moment...</title>' })).toBe(true);
  });

  it('does not take a 200 page for a challenge because it embeds Turnstile or says "just a moment"', () => {
    expect(isChallenge({ status: 200, headers: {}, html: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>' })).toBe(false);
    expect(isChallenge({ status: 200, headers: {}, html: '<html><title>Blog</title><p>Just a moment, please read on.</p></html>' })).toBe(false);
    expect(liveVerdict({ bot: res(200, { html: '<p>just a moment</p>' }), browser: res(200) }).verdict).toBe('ok');
  });

  it('is ok when the bot gets through', () => {
    expect(liveVerdict({ bot: res(200), browser: res(200) })).toEqual({ verdict: 'ok', status: 200 });
  });

  it('is unknown when the browser is blocked or a fetch failed', () => {
    expect(liveVerdict({ bot: res(403), browser: res(403) }).verdict).toBe('unknown');
    expect(liveVerdict({ bot: res(403), browser: res(200, { headers: { 'cf-mitigated': 'challenge' } }) }).verdict).toBe('unknown');
    expect(liveVerdict({ bot: null, browser: res(200) }).verdict).toBe('unknown');
    expect(liveVerdict({ bot: res(200), browser: null }).verdict).toBe('unknown');
  });

  it('sums several URLs: blocked beats ok beats unknown', () => {
    const o = { verdict: 'ok', status: 200 };
    const b = { verdict: 'blocked', status: 403 };
    const u = { verdict: 'unknown', status: null };
    expect(liveSummary([o, b]).verdict).toBe('blocked');
    expect(liveSummary([u, o]).verdict).toBe('ok');
    expect(liveSummary([u, u]).verdict).toBe('unknown');
  });

  it('builds the bot user agent', () => expect(botUserAgent('GPTBot')).toBe('Mozilla/5.0 (compatible; GPTBot/1.0)'));
});
