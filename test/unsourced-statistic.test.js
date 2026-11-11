import { describe, it, expect } from 'vitest';
import { FAQ_BLOCK, makeBody, makeValidPage } from './helpers/valid-page.js';
import { validate, unsourcedStatisticSentences } from '../src/steps/validate.js';

// Every project: a statistic (share of a group, ratio, cited study) needs a source.

const KW = { keyword: 'Webdesign Berlin', expected_entities: [] };
const SOURCES = 'sources:\n  - url: https://example.test/quelle\n    title: Quelle\n';
const statErrors = (md, opts = {}) => validate(md, KW, opts).errors.filter(e => e.startsWith('Unsourced statistic'));
const withBody = (extra, sources = '') => {
  const md = makeValidPage({ body: makeBody(`\n\n${extra}`) });
  return sources ? md.replace(FAQ_BLOCK, sources + FAQ_BLOCK) : md;
};

describe('unsourcedStatisticSentences', () => {
  it.each([
    'Etwa 70 Prozent des Jahrgangs sind so erreichbar.',
    'Die Rückmeldequote liegt bei 70 bis 85 Prozent der Eingeladenen.',
    'Wer zu spät einlädt, riskiert, dass jeder zweite Gast absagt.',
    'Acht von 10 Gästen kommen, 8 von 10 bleiben.',
    'Laut einer Studie bleiben Gäste länger.',
    'Studien zeigen, dass Listen helfen.',
    'About 70 percent of the class is reachable this way.',
    'According to a survey, guests stay longer.',
  ])('flags "%s"', (s) => {
    expect(unsourcedStatisticSentences(s)).toHaveLength(1);
  });

  it.each([
    'Kalkuliert einen Puffer von 10 Prozent ein.',
    'Bezahlt wird in zwei Raten: 50 Prozent bei Start, 50 Prozent nach Abschluss.',
    'Die Umsatzsteuer beträgt 19 % auf den Nettobetrag.',
    'Starte eine Umfrage mit drei Optionen.',
    'Streiche jede zweite Funktion.',
    'Plane 6 bis 8 Wochen ein.',
  ])('leaves "%s" alone', (s) => {
    expect(unsourcedStatisticSentences(s)).toEqual([]);
  });

  it('accepts a statistic whose paragraph links to a source', () => {
    expect(unsourcedStatisticSentences('Etwa 70 Prozent der Gäste sagen zu ([Quelle](https://example.test/q)).')).toEqual([]);
  });
});

describe('validate: unsourced statistic', () => {
  it('is an error on a standard project', () => {
    const errors = statErrors(withBody('Etwa 70 Prozent der Gäste sagen zu.'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('70 Prozent der Gäste');
  });

  it('accepts the statistic with a sources entry', () => {
    expect(statErrors(withBody('Etwa 70 Prozent der Gäste sagen zu.', SOURCES))).toEqual([]);
  });

  it('checks the tldr and the FAQ answers too', () => {
    const md = makeValidPage().replace(/^tldr: .*$/m, 'tldr: "Jeder dritte Gast sagt spät ab, deshalb lohnt sich eine frühe Einladung mit klarer Frist und einer Erinnerung kurz vorher, damit du verlässlich planen kannst und am Ende genug für alle da ist."');
    expect(statErrors(md)).toHaveLength(1);
  });

  it('is not repeated as a statistic under strict, where the percent sentence is already an unsourced number', () => {
    const errors = validate(withBody('Etwa 70 % der Gäste sagen zu.'), KW, { strict: true }).errors;
    expect(errors.filter(e => e.startsWith('Unsourced number') && e.includes('70 %'))).toHaveLength(1);
    expect(errors.filter(e => e.startsWith('Unsourced statistic'))).toEqual([]);
  });

  it('reports a spelled-out percent under strict, which the percent sign rule misses', () => {
    expect(statErrors(withBody('Etwa 70 Prozent der Gäste sagen zu.'), { strict: true })).toHaveLength(1);
  });

  it('reports a ratio under strict, which the percent rule misses', () => {
    expect(statErrors(withBody('Acht von zehn, also 8 von 10 Gästen, sagen zu.'), { strict: true })).toHaveLength(1);
  });
});
