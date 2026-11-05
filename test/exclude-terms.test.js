import { describe, it, expect } from 'vitest';
import { matchExcludedTerm } from '../src/lib/exclude-terms.js';

describe('matchExcludedTerm', () => {
  const terms = ['webflow', 'Home Assistant'];

  it('matches a term at the start of a word, in keywords and slugs, case-insensitive', () => {
    expect(matchExcludedTerm('webflow website erstellen lassen nürnberg', terms)).toBe('webflow');
    expect(matchExcludedTerm('Webflow-Agentur Fürth', terms)).toBe('webflow');
    expect(matchExcludedTerm('webflowseite kosten', terms)).toBe('webflow');
    expect(matchExcludedTerm('webflow-entwickler-fuerth', terms)).toBe('webflow');
  });

  it('matches multi-word terms across spaces and hyphens', () => {
    expect(matchExcludedTerm('home-assistant einrichten', terms)).toBe('Home Assistant');
  });

  it('does not match inside a word or without terms', () => {
    expect(matchExcludedTerm('nowebflow test', terms)).toBeNull();
    expect(matchExcludedTerm('wordpress website nürnberg', terms)).toBeNull();
    expect(matchExcludedTerm('webflow website', [])).toBeNull();
    expect(matchExcludedTerm('webflow website', ['', '  '])).toBeNull();
  });
});
