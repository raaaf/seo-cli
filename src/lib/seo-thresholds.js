export const SEO_THRESHOLDS = Object.freeze({
  metaTitle:       { shortWarn: 40, errorMax: 65, idealMin: 50, idealMax: 60, okMin: 45, okMax: 65 },
  metaDescription: { shortWarn: 120, errorMax: 170, idealMin: 140, idealMax: 160, okMin: 130, okMax: 165 },
  tldrWords:       { errorMin: 40, errorMax: 60, idealMin: 40, idealMax: 60, okMin: 35, okMax: 65 },
  bodyWords:       { errorMin: 800, longWarn: 1400, okMin: 800, warnMin: 700 },
  faqMin: 3,
  extLinksMin: 1,
});
