import { describe, it, expect } from 'vitest';
import { buildQueue, nextInLine, trafficBrake, whyBlock } from '../src/lib/queue.js';

const TODAY = '2026-11-16';
const c = (type, slug, extra = {}) => ({ type, slug, source: 'gsc', why: 'w', score: 1, touches: [slug], ...extra });
const build = (candidates, extra = {}) => buildQueue({ candidates, today: TODAY, config: { max_prs_per_run: 4, base_url: 'https://demo.example' }, ...extra });
const statusOf = (result, slug) => result.queue.find(e => e.slug === slug);
const days = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe('rank', () => {
  it('orders by type rank, then assessed before GSC, then score', () => {
    const result = build([
      c('new_page', 'n'), c('snippet_test', 's'), c('rewrite', 'gsc-low', { score: 1 }), c('rewrite', 'gsc-high', { score: 9 }),
      c('rewrite', 'alert', { source: 'alert', score: 0 }), c('refresh', 'r'), c('merge', 'm'), c('overlay', 'o'),
    ], { config: { max_prs_per_run: 9 } });
    expect(result.queue.map(e => e.slug)).toEqual(['m', 'r', 'alert', 'gsc-high', 'gsc-low', 's', 'o', 'n']);
  });
});

describe('dedup over touches', () => {
  it('defers the lower ranked candidate that touches a slug a higher one already takes', () => {
    const result = build([c('rewrite', 'a', { source: 'alert' }), c('rewrite', 'b', { touches: ['b', 'a'] })]);
    expect(statusOf(result, 'a')).toMatchObject({ status: 'selected' });
    expect(statusOf(result, 'b')).toMatchObject({ status: 'deferred', reason: 'overlap' });
  });
});

describe('cap', () => {
  it('keeps one slot for page work when rewrites alone would fill the cap', () => {
    const result = build([c('merge', 'm1'), c('merge', 'm2'), c('refresh', 'r1'), c('rewrite', 'w1'), c('new_page', 'n1')], { config: { max_prs_per_run: 3 } });
    expect(result.queue.filter(e => e.status === 'selected').map(e => e.slug).sort()).toEqual(['m1', 'm2', 'n1']);
    expect(statusOf(result, 'r1')).toMatchObject({ status: 'deferred', reason: 'cap' });
  });

  it('counts only opened reverts against the cap, not skipped ones', () => {
    const executed = [
      { type: 'revert', slug: 'x', status: 'opened' }, { type: 'revert', slug: 'y', status: 'opened' },
      { type: 'revert', slug: 'z', status: 'blocked', reason: 'skipped' },
    ];
    const result = build([c('refresh', 'r'), c('rewrite', 'w'), c('new_page', 'n')], { executed, config: { max_prs_per_run: 4 } });
    expect(result.queue.filter(e => e.status === 'selected').map(e => e.slug)).toEqual(['r', 'n']);
    expect(statusOf(result, 'w')).toMatchObject({ status: 'deferred', reason: 'cap' });
  });

  it('moves the next cap-deferred entry up when asked, in rank order', () => {
    const result = build([c('refresh', 'r'), c('rewrite', 'w1'), c('rewrite', 'w2')], { config: { max_prs_per_run: 1 } });
    expect(nextInLine(result.queue, 2).map(e => e.slug)).toEqual(['w1', 'w2']);
    expect(nextInLine(result.queue, 0)).toEqual([]);
  });
});

describe('locks and brake', () => {
  it('lets only reverts run when paused', () => {
    const result = build([c('new_page', 'n'), c('refresh', 'r')], { config: { paused: true } });
    expect(result.queue.every(e => e.status === 'blocked' && e.reason === 'paused')).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/paused/);
  });

  const drop = { id: 'traffic_drop', kind: 'traffic_drop', since: TODAY };
  const merged = (n) => [{ merged_at: days(-n) }];

  it('brakes new pages, snippet tests, refreshes and GSC rewrites after a drop 7 to 35 days after our last merge', () => {
    const result = build([c('new_page', 'n'), c('snippet_test', 's'), c('refresh', 'r', { source: 'season' }), c('rewrite', 'g'), c('rewrite', 'a', { source: 'alert' }), c('merge', 'm')], { alerts: [drop], changes: merged(10) });
    expect(['n', 's', 'r', 'g'].map(s => statusOf(result, s).reason)).toEqual(['brake', 'brake', 'brake', 'brake']);
    expect(statusOf(result, 'a').status).toBe('selected');
    expect(statusOf(result, 'm').status).toBe('selected');
    expect(result.warnings.join(' ')).toMatch(/brake active for 0 day/i);
  });

  it('does not brake a drop that came less than 7 or more than 35 days after the last merge', () => {
    expect(trafficBrake({ alerts: [drop], changes: merged(3), today: TODAY })).toBeNull();
    expect(trafficBrake({ alerts: [drop], changes: merged(40), today: TODAY })).toBeNull();
  });

  it('uses the newest merge before the drop, so a later merge in between ends the blame', () => {
    expect(trafficBrake({ alerts: [drop], changes: [{ merged_at: days(-20) }, { merged_at: days(-2) }], today: TODAY })).toBeNull();
  });

  it('releases the brake after 56 days with a warning', () => {
    const old = { ...drop, since: days(-60) };
    const result = build([c('new_page', 'n')], { alerts: [old], changes: [{ merged_at: days(-80) }] });
    expect(statusOf(result, 'n').status).toBe('selected');
    expect(result.warnings.join(' ')).toMatch(/brake released/i);
  });

  it('blocks new pages while site_not_indexed is open', () => {
    const result = build([c('new_page', 'n'), c('snippet_test', 's')], { alerts: [{ id: 'site_not_indexed', kind: 'site_not_indexed' }] });
    expect(statusOf(result, 'n')).toMatchObject({ status: 'blocked', reason: 'site_not_indexed' });
    expect(statusOf(result, 's').status).toBe('selected');
  });

  it('blocks everything that touches a slug with an open not_deployed alert', () => {
    const result = build([c('rewrite', 'a', { touches: ['a', 'b'] }), c('rewrite', 'c')], { alerts: [{ id: 'not_deployed:b', kind: 'not_deployed' }] });
    expect(statusOf(result, 'a')).toMatchObject({ status: 'blocked', reason: 'not_deployed' });
    expect(statusOf(result, 'c').status).toBe('selected');
  });

  describe('recrawl lock for the target of a merge or removal', () => {
    const improvements = { entries: [{ slug: 'target', date: days(-10), merged_at: days(-10), merge: true }] };
    const crawl = (day) => [{ url: 'https://demo.example/target', lastCrawlTime: `${day}T10:00:00Z` }];

    it('blocks a rewrite and a snippet test until a crawl after the merge shows', () => {
      const result = build([c('rewrite', 'target'), c('snippet_test', 'target', { touches: ['t2'] }), c('refresh', 'target', { source: 'season', touches: ['t3'] })], { improvements, indexEntries: crawl(days(-20)) });
      expect(result.queue.filter(e => e.reason === 'recrawl').map(e => e.type)).toEqual(['rewrite', 'snippet_test']);
      expect(result.queue.find(e => e.type === 'refresh').status).toBe('selected');
    });

    it('lets the page through once Google crawled it after the merge', () => {
      const result = build([c('rewrite', 'target')], { improvements, indexEntries: crawl(days(-3)) });
      expect(statusOf(result, 'target').status).toBe('selected');
    });

    it('takes the target of a removal from its into field', () => {
      const result = build([c('rewrite', 'target')], { improvements: { entries: [{ slug: 'gone', into: 'target', date: days(-5), merged_at: days(-5), prune: true }] } });
      expect(statusOf(result, 'target')).toMatchObject({ status: 'blocked', reason: 'recrawl' });
    });
  });

  describe('open drafts', () => {
    it('does not choose a slug again whose PR is still open', () => {
      const result = build([c('rewrite', 'a'), c('rewrite', 'b')], { improvements: { entries: [{ slug: 'a', date: days(-1), pr_url: 'https://github.com/o/r/pull/1' }] } });
      expect(statusOf(result, 'a')).toMatchObject({ status: 'blocked', reason: 'open_pr' });
      expect(statusOf(result, 'b').status).toBe('selected');
    });

    const heldEntries = (n) => Array.from({ length: n }, (_, i) => ({ slug: `h${i}`, date: days(-1), pr_url: `https://github.com/o/r/pull/${i}`, held: true }));

    it('defers new non-auto types from the third held draft on, but not auto types', () => {
      const result = build([c('rewrite', 'w'), c('new_page', 'n')], { improvements: { entries: heldEntries(3) } });
      expect(statusOf(result, 'w')).toMatchObject({ status: 'deferred', reason: 'drafts_waiting' });
      expect(statusOf(result, 'n').status).toBe('selected');
      expect(build([c('rewrite', 'w')], { improvements: { entries: heldEntries(2) } }).queue[0].status).toBe('selected');
    });

    it('warns about a held draft older than 14 days', () => {
      const entries = [{ slug: 'old', date: days(-15), pr_url: 'https://github.com/o/r/pull/9', held: true }, { slug: 'fresh', date: days(-3), pr_url: 'https://github.com/o/r/pull/10', held: true }];
      const warnings = build([], { improvements: { entries } }).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/old.*15 days/);
    });
  });
});

describe('whyBlock', () => {
  it('lists type, source, reason and score', () => {
    expect(whyBlock({ type: 'merge', source: 'alert', why: 'duplicate', score: 3 })).toBe('## Warum diese Aktion\n\n- Typ: merge\n- Quelle: alert\n- Begründung: duplicate\n- Score: 3\n\n');
  });
});
