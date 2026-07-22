import { describe, it, expect } from 'vitest';
import { tokenize, isSameTokenSet, findTokenSetDuplicate } from '../src/lib/similarity.js';

describe('tokenize', () => {
  it('drops function words', () => {
    expect([...tokenize('rechnung für freelancer ohne umsatzsteuer')])
      .toEqual(['rechnung', 'freelancer', 'ohne', 'umsatzsteuer'].filter(t => t !== 'ohne'));
  });

  it('treats a slug like a keyword', () => {
    expect([...tokenize('webdesign-freelancer-preise')].sort())
      .toEqual(['freelancer', 'preise', 'webdesign']);
  });

  it('falls back to all tokens when everything is a stopword', () => {
    expect([...tokenize('für und mit')]).toEqual(['für', 'und', 'mit']);
  });
});

describe('isSameTokenSet', () => {
  it('matches word-order variants', () => {
    expect(isSameTokenSet('freelancer webdesign preise', 'webdesign freelancer preise')).toBe(true);
  });

  it('matches a keyword against the slug of the same intent', () => {
    expect(isSameTokenSet('webdesign freelancer preise', 'freelancer-webdesign-preise')).toBe(true);
  });

  it('does not match when a topical token differs', () => {
    expect(isSameTokenSet('zeiterfassung pflicht freelancer', 'zeiterfassung software freelancer')).toBe(false);
  });

  it('does not match a subset', () => {
    expect(isSameTokenSet('stundensatz berechnen', 'stundensatz berechnen freelancer')).toBe(false);
  });

  it('ignores empty input', () => {
    expect(isSameTokenSet('', '')).toBe(false);
  });
});

describe('findTokenSetDuplicate', () => {
  it('returns the colliding candidate', () => {
    const existing = ['zeiterfassung-pflicht-freelancer', 'webdesign freelancer preise'];
    expect(findTokenSetDuplicate('freelancer webdesign preise', existing)).toBe('webdesign freelancer preise');
  });

  it('returns null when nothing collides', () => {
    expect(findTokenSetDuplicate('taufe organisieren', ['kommunion feier planen'])).toBeNull();
  });
});
