import { describe, it, expect } from 'vitest';
import { SEO_THRESHOLDS } from '../src/lib/seo-thresholds.js';

describe('SEO_THRESHOLDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(SEO_THRESHOLDS)).toBe(true);
  });

  it('metaTitle values match source', () => {
    expect(SEO_THRESHOLDS.metaTitle).toEqual({
      shortWarn: 40,
      errorMax: 65,
      idealMin: 50,
      idealMax: 60,
      okMin: 45,
      okMax: 65,
    });
  });

  it('metaDescription values match source', () => {
    expect(SEO_THRESHOLDS.metaDescription).toEqual({
      shortWarn: 120,
      errorMax: 170,
      idealMin: 140,
      idealMax: 160,
      okMin: 130,
      okMax: 165,
    });
  });

  it('tldrWords values match source', () => {
    expect(SEO_THRESHOLDS.tldrWords).toEqual({
      errorMin: 40,
      errorMax: 60,
      idealMin: 40,
      idealMax: 60,
      okMin: 35,
      okMax: 65,
    });
  });

  it('bodyWords values match source', () => {
    expect(SEO_THRESHOLDS.bodyWords).toEqual({
      errorMin: 800,
      longWarn: 1400,
      okMin: 800,
      warnMin: 700,
    });
  });

  it('faqMin is 3', () => {
    expect(SEO_THRESHOLDS.faqMin).toBe(3);
  });

  it('extLinksMin is 1', () => {
    expect(SEO_THRESHOLDS.extLinksMin).toBe(1);
  });
});
