import { describe, it, expect } from 'vitest';
import { validate } from '../src/steps/validate.js';
import { TLDR_50, FAQ_BLOCK, makeBody, makeValidPage as makeValid } from './helpers/valid-page.js';

const KW = { keyword: 'Webdesign Berlin', expected_entities: [] };

describe('validate-page: validate', () => {
  it('returns ok:false with error when no frontmatter', () => {
    const { ok, errors } = validate('just plain text without frontmatter', KW);
    expect(ok).toBe(false);
    expect(errors).toContain('No YAML frontmatter found');
  });

  it('reports missing required fields', () => {
    const md = `---\nslug: test\n---\nbody text`;
    const { errors } = validate(md, KW);
    expect(errors.some(e => e.includes('meta_title'))).toBe(true);
  });

  it('reports body too short', () => {
    const md = `---
slug: test
meta_title: Webdesign Berlin Titel fuer kurze Tests hier heute
meta_description: Eine kurze Beschreibung fuer Webdesign Berlin, die lang genug ist fuer den Test und mehr als 130 Zeichen aufweist.
hero:
  headline: Webdesign Berlin Test
tldr: "${TLDR_50}"
${FAQ_BLOCK}
---
Webdesign Berlin ist wichtig. Zahlen: 1 2 3 4 5.`;
    const { errors } = validate(md, KW);
    expect(errors.some(e => e.includes('Body too short'))).toBe(true);
  });

  it('passes a fully valid document', () => {
    const { ok } = validate(makeValid(), KW);
    expect(ok).toBe(true);
  });

  it('warns when a multi-word keyword is only partially present (not just the first token)', () => {
    // Body/headline contain "Webdesign Berlin"; "Hamburg" is missing.
    const { ok, warnings } = validate(makeValid(), { keyword: 'Webdesign Hamburg', expected_entities: [] });
    expect(ok).toBe(true); // keyword presence is a warning, not a gate
    expect(warnings.some(w => /hamburg/i.test(w))).toBe(true);
  });

  it('errors on em-dash in body', () => {
    const { errors } = validate(makeValid({ body: makeBody('Webdesign Berlin — super.') }), KW);
    expect(errors.some(e => e.includes('Em-dash'))).toBe(true);
  });

  it('errors on keyword stuffing', () => {
    const stuffed = 'Webdesign Berlin '.repeat(60) + 'Zahlen: 1 2 3 4 5.';
    const { errors } = validate(makeValid({ body: stuffed }), KW);
    expect(errors.some(e => e.includes('stuffing'))).toBe(true);
  });

  it('errors when tldr is too short', () => {
    const shortTldr = 'Webdesign Berlin bietet professionelle Webseiten fuer Unternehmen mit moderner Gestaltung und klarer Struktur.';
    const { errors } = validate(makeValid({ tldr: shortTldr }), KW);
    expect(errors.some(e => e.includes('tldr too short'))).toBe(true);
  });

  it('errors when tldr is too long', () => {
    // TLDR_50 (50 words) + 14 more = 64 words, above the 60-word limit
    const longTldr = TLDR_50 + ' Zusaetzlich profitieren Teams von messbaren Ergebnissen klaren Prozessen und einer Struktur die langfristig traegt.';
    const { errors } = validate(makeValid({ tldr: longTldr }), KW);
    expect(errors.some(e => e.includes('tldr too long'))).toBe(true);
  });

  it('errors on fabricated pattern "aus meiner Praxis"', () => {
    const { errors } = validate(makeValid({ body: makeBody('Das habe ich aus meiner Praxis gelernt.') }), KW);
    expect(errors.some(e => e.includes('Fabricated claim'))).toBe(true);
  });
});
