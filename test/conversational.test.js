import { describe, it, expect } from 'vitest';
import { classifyQuery, groupConversational } from '../src/lib/conversational.js';

describe('classifyQuery', () => {
  it('recognises a bare affirmation as an artefact of replying to an AI', () => {
    expect(classifyQuery('ja')).toBe('artefact');
  });

  it('recognises a bare number as an artefact', () => {
    expect(classifyQuery('1')).toBe('artefact');
  });

  it('does not treat "ja" as an artefact when it is part of a real phrase', () => {
    expect(classifyQuery('ja oder nein bei webdesign vertrag')).toBe('keyword');
  });

  it('recognises a tracker-probe location suffix', () => {
    expect(classifyQuery('wie lange dauert die erstellung eines onlineshops?. my location is austria.')).toBe('tracker_probe');
  });

  it('lets the tracker-probe signature win over the conversational-opener rule', () => {
    // The string above also opens with "wie lange", which would otherwise match
    // CONVERSATIONAL_OPENERS — the probe signature must take priority.
    const q = 'wie lange dauert die erstellung eines onlineshops?. my location is austria.';
    expect(classifyQuery(q)).not.toBe('conversational');
  });

  it('recognises an evaluate-brand-on-facet tracker probe', () => {
    expect(classifyQuery('evaluate acme on pricing transparency')).toBe('tracker_probe');
  });

  it('recognises a real conversational question by its opener', () => {
    expect(classifyQuery('wie viel kostet es, eine website bei einem webdesigner in der umgebung zu erstellen?')).toBe('conversational');
  });

  it('recognises a long query as conversational even without an opener', () => {
    const q = 'unser website-relaunch startet in drei monaten und bisher hat niemand an seo gedacht';
    expect(q.split(/\s+/).length).toBeGreaterThanOrEqual(9);
    expect(classifyQuery(q)).toBe('conversational');
  });

  it('leaves an ordinary keyword search unclassified as anything special', () => {
    expect(classifyQuery('webdesign preise vergleich')).toBe('keyword');
  });
});

describe('groupConversational', () => {
  const rows = [
    { query: 'ja', page: '/x', position: 3.6, impressions: 16, clicks: 0 },
    { query: '1', page: '/x', position: 5.5, impressions: 2, clicks: 0 },
    { query: 'wie lange dauert die erstellung eines onlineshops?. my location is austria.', page: '/y', position: 6.5, impressions: 4, clicks: 0 },
    { query: 'wie viel kostet es, eine website bei einem webdesigner in der umgebung zu erstellen?', page: '/y', position: 1.0, impressions: 4, clicks: 0 },
    { query: 'webdesign preise vergleich', page: '/z', position: 8.0, impressions: 50, clicks: 3 },
  ];

  it('groups rows into buckets sorted by impressions descending, with totals per bucket', () => {
    const grouped = groupConversational(rows);
    expect(grouped.artefact.map(r => r.query)).toEqual(['ja', '1']);
    expect(grouped.tracker_probe).toHaveLength(1);
    expect(grouped.conversational).toHaveLength(1);
    expect(grouped.keyword).toHaveLength(1);
    expect(grouped.totals.artefact).toEqual({ count: 2, impressions: 18 });
  });
});
