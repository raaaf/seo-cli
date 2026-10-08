import { describe, it, expect } from 'vitest';
import { serpPriority, getPending } from '../src/lib/keywords.js';

const aio = { ai_overview: true, ai_overview_cites_us: false, checked_at: new Date().toISOString().slice(0, 10) };
const kw = (over) => ({ keyword: 'k', status: 'proposed', score: 8, intent: 'informational', serp_features: aio, ...over });

describe('serpPriority', () => {
  it('lowers an informational keyword with an AI Overview by 2', () => {
    expect(serpPriority(kw())).toBe(6);
  });
  it('leaves the keyword alone when the AI Overview cites us', () => {
    expect(serpPriority(kw({ serp_features: { ...aio, ai_overview_cites_us: true } }))).toBe(8);
  });
  it('does not demote without evidence (cites_us null)', () => {
    expect(serpPriority(kw({ serp_features: { ...aio, ai_overview_cites_us: null } }))).toBe(8);
  });
  it('matches the intent after trim and lowercase', () => {
    expect(serpPriority(kw({ intent: ' Informational ' }))).toBe(6);
  });
  it('ignores features older than 60 days or without a date', () => {
    const now = new Date('2026-10-07T00:00:00Z');
    expect(serpPriority(kw({ serp_features: { ...aio, checked_at: '2026-08-09' } }), now)).toBe(6);
    expect(serpPriority(kw({ serp_features: { ...aio, checked_at: '2026-08-07' } }), now)).toBe(8);
    expect(serpPriority(kw({ serp_features: { ...aio, checked_at: undefined } }), now)).toBe(8);
  });
  it('leaves commercial intent alone', () => {
    expect(serpPriority(kw({ intent: 'commercial' }))).toBe(8);
  });
  it('leaves a keyword without AI Overview or without features alone', () => {
    expect(serpPriority(kw({ serp_features: { ai_overview: false, ai_overview_cites_us: false } }))).toBe(8);
    expect(serpPriority(kw({ serp_features: undefined }))).toBe(8);
  });
});

describe('getPending ordering', () => {
  it('works off the penalised keyword later but keeps it pending with its score', () => {
    const data = { keywords: [kw({ keyword: 'aio', score: 8 }), kw({ keyword: 'plain', score: 7, intent: 'commercial' })] };
    const pending = getPending(data, 7);
    expect(pending.map(k => k.keyword)).toEqual(['plain', 'aio']);
    expect(pending[1].score).toBe(8);
  });
});
