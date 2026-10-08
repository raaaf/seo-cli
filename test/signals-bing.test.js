import { describe, it, expect } from 'vitest';
import { aggregateQueries, filterQueries, bingQuestionsFor } from '../src/lib/signals/bing.js';

// Assumption: `now` is a Date.
const now = new Date('2026-10-08T00:00:00Z');
const DAY = 86400000;
const row = (Query, Impressions, Clicks, AvgImpressionPosition, daysAgo) => ({
  Query,
  Impressions,
  Clicks,
  AvgImpressionPosition,
  Date: `/Date(${now.getTime() - daysAgo * DAY})/`,
});

describe('aggregateQueries', () => {
  it('groups case-insensitively, sums counts and weights the position by impressions', () => {
    const out = aggregateQueries([
      row('Steuer Freelancer', 10, 1, 2, 5),
      row('  steuer freelancer ', 30, 2, 4, 6),
    ], { now });
    expect(out).toHaveLength(1);
    expect(out[0].query.trim().toLowerCase()).toBe('steuer freelancer');
    expect(out[0]).toMatchObject({ impressions: 40, clicks: 3, position: 3.5 });
  });

  it('rounds the weighted position to one decimal', () => {
    const out = aggregateQueries([row('a', 1, 0, 1, 1), row('a', 2, 0, 2, 2)], { now });
    expect(out[0].position).toBe(1.7);
  });

  it('drops rows older than the days window', () => {
    const out = aggregateQueries([row('old', 99, 9, 1, 181), row('new', 1, 0, 1, 179)], { now, days: 180 });
    expect(out.map(q => q.query)).toEqual(['new']);
  });

  it('sorts by impressions desc and caps at limit', () => {
    const rows = [row('low', 1, 0, 1, 1), row('high', 50, 0, 1, 1), row('mid', 5, 0, 1, 1)];
    expect(aggregateQueries(rows, { now }).map(q => q.query)).toEqual(['high', 'mid', 'low']);
    expect(aggregateQueries(rows, { now, limit: 2 }).map(q => q.query)).toEqual(['high', 'mid']);
  });
});

describe('filterQueries', () => {
  const q = query => ({ query, impressions: 1 });

  it('drops emails, 6+ digit runs, phone numbers and over-long queries', () => {
    const dropped = [
      'kontakt max@example.de',
      'rechnung 123456',
      '+49 151 2345678',
      '0151-2345678',
      'x'.repeat(121),
    ];
    expect(filterQueries(dropped.map(q))).toEqual([]);
  });

  it('keeps ordinary questions, short digit runs and a 120 character query', () => {
    const kept = [
      'wieviele stunden pro jahr kann man als freiberufler realistisch berechnen?',
      'steuer 2026 12345',
      'y'.repeat(120),
    ];
    expect(filterQueries(kept.map(q)).map(e => e.query)).toEqual(kept);
  });
});

describe('bingQuestionsFor', () => {
  const list = [
    { query: 'was kostet steuer für freelancer', impressions: 5 },
    { query: 'Freelancer Steuer erklärt', impressions: 20 },
    { query: 'steuer ohne den bezug', impressions: 99 },
    { query: 'steuer freelancer mit buchhaltung', impressions: 10 },
  ];

  it('requires all significant tokens, ignores stop words and sorts by impressions desc', () => {
    expect(bingQuestionsFor('Steuer für die Freelancer', list)).toEqual([
      'Freelancer Steuer erklärt',
      'steuer freelancer mit buchhaltung',
      'was kostet steuer für freelancer',
    ]);
  });

  it('caps the result at max (default 8)', () => {
    expect(bingQuestionsFor('steuer freelancer', list, { max: 2 })).toHaveLength(2);
    const many = Array.from({ length: 12 }, (_, i) => ({ query: `steuer freelancer ${i}`, impressions: i }));
    expect(bingQuestionsFor('steuer freelancer', many)).toHaveLength(8);
  });
});
