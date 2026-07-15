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

  it('warns on anglicisms with German equivalents (Edge Case, Case Study)', () => {
    const edge = validate(makeValid({ body: makeBody('Jede Funktion produziert Edge-Cases.') }), KW);
    expect(edge.ok).toBe(true);
    expect(edge.warnings.some(w => /Edge Case/.test(w))).toBe(true);

    const cs = validate(makeValid({ body: makeBody('Statt erfundener Case Studies gibt es Beispiele.') }), KW);
    expect(cs.warnings.some(w => /Case Study/.test(w))).toBe(true);
  });

  it('warns on anglicisms Reports and Insights', () => {
    const reports = validate(makeValid({ body: makeBody('Das Dashboard liefert woechentliche Team-Reports fuer alle.') }), KW);
    expect(reports.warnings.some(w => /Berichte/.test(w))).toBe(true);

    const insights = validate(makeValid({ body: makeBody('Das Tool liefert detaillierte Insights zu jeder Kampagne.') }), KW);
    expect(insights.warnings.some(w => /Auswertungen/.test(w))).toBe(true);
  });

  it('does not warn on Berichte und Auswertungen', () => {
    const { warnings } = validate(makeValid({ body: makeBody('Das Dashboard liefert woechentliche Berichte und Auswertungen fuer alle.') }), KW);
    expect(warnings.some(w => /Berichte/.test(w))).toBe(false);
    expect(warnings.some(w => /Auswertungen/.test(w))).toBe(false);
  });

  it('warns on stale brand name lexoffice', () => {
    const { ok, warnings } = validate(makeValid({ body: makeBody('Export direkt nach lexoffice und sevDesk.') }), KW);
    expect(ok).toBe(true);
    expect(warnings.some(w => /Lexware Office/.test(w))).toBe(true);
  });

  it('warns on stale 2025 tax threshold 68.430', () => {
    const { warnings } = validate(makeValid({ body: makeBody('42 Prozent Grenzsteuersatz oberhalb 68.430 EUR greifen.') }), KW);
    expect(warnings.some(w => /Grenzsteuersatz/.test(w))).toBe(true);
  });

  it('warns on stale "10 Jahre" retention period near aufbewahren/archivieren', () => {
    const a = validate(makeValid({ body: makeBody('Rechnungen musst du nach Paragraf 147 AO zehn Jahre aufbewahren.') }), KW);
    expect(a.warnings.some(w => /Aufbewahrungsfrist/.test(w))).toBe(true);

    const b = validate(makeValid({ tldr: 'Aufbewahrungsfristen von bis zu 10 Jahren gelten fuer Rechnungsbelege in jedem Unternehmen unabhaengig von Groesse oder Branche und Umsatz Kunden Projekte Struktur Planung Ablage Jahr Frist Beleg Buchhaltung heute jetzt bald jederzeit ueberall wirklich klar deutlich einfach schnell direkt sofort stets normal typisch ueblich gaengig verbreitet bekannt wichtig zentral relevant.' }), KW);
    expect(b.warnings.some(w => /Aufbewahrungsfrist/.test(w))).toBe(true);
  });

  it('does not warn on "10 Jahre" phrasing unrelated to retention', () => {
    const experience = validate(makeValid({ body: makeBody('Sie arbeitet seit zehn Jahren als Freelancer im Bereich Webdesign.') }), KW);
    expect(experience.warnings.some(w => /Aufbewahrungsfrist/.test(w))).toBe(false);

    const wrongPeriod = validate(makeValid({ body: makeBody('Buchungsbelege muss man acht Jahre aufbewahren.') }), KW);
    expect(wrongPeriod.warnings.some(w => /Aufbewahrungsfrist/.test(w))).toBe(false);
  });

  it('warns on Bruttoumsatz near Kleinunternehmer thresholds', () => {
    const { warnings } = validate(makeValid({ body: makeBody('Die Grenzen liegen bei 25.000 EUR. Beide Werte beziehen sich auf den Bruttoumsatz.') }), KW);
    expect(warnings.some(w => /Nettoumsatz/.test(w))).toBe(true);
  });

  it('does not warn on Bruttoumsatz without a Kleinunternehmer/threshold anchor nearby', () => {
    const { warnings } = validate(makeValid({ body: makeBody('Der Onlineshop verzeichnet einen soliden Bruttoumsatz in diesem Quartal.') }), KW);
    expect(warnings.some(w => /Nettoumsatz/.test(w))).toBe(false);
  });

  it('warns on wrong brand casing (Wordpress)', () => {
    const { warnings } = validate(makeValid({ body: makeBody('Ich baue Seiten mit Wordpress und eigenem Theme.') }), KW);
    expect(warnings.some(w => /write "WordPress"/.test(w))).toBe(true);
  });

  it('does not flag brand casing for a lowercase brand inside a URL', () => {
    const body = makeBody('WordPress laeuft laut [W3Techs](https://w3techs.com/technologies/details/cm-wordpress) ueberall.');
    const { warnings } = validate(makeValid({ body }), KW);
    expect(warnings.some(w => /Brand casing/.test(w))).toBe(false);
  });

  it('does not flag brand casing for a lowercase brand inside a relative link target', () => {
    const body = makeBody('WordPress passt zu jedem Projekt, siehe [gepflegte Website](/wordpress-website-erstellen-lassen).');
    const { warnings } = validate(makeValid({ body }), KW);
    expect(warnings.some(w => /Brand casing/.test(w))).toBe(false);
  });

  it('does not flag brand casing for a lowercase brand inside a frontmatter related_pages slug', () => {
    const md = `---
slug: webdesign-berlin
meta_title: Webdesign Berlin fuer professionelle Webseiten Projekte
meta_description: Professionelles Webdesign Berlin fuer kleine und mittlere Unternehmen. Moderne Gestaltung, schnelle Umsetzung und klare Struktur fuer mehr Conversions und Sichtbarkeit.
hero:
  headline: Webdesign Berlin fuer moderne Unternehmen
tldr: "${TLDR_50}"
related_pages:
  - wordpress-website-erstellen-lassen
${FAQ_BLOCK}
---
${makeBody()}`;
    const { warnings } = validate(md, KW);
    expect(warnings.some(w => /Brand casing/.test(w))).toBe(false);
  });

  it('still warns on prose "Edge-Cases" (single hyphen, not a slug) alongside brand casing', () => {
    const { ok, warnings } = validate(makeValid({ body: makeBody('Jede Funktion produziert Edge-Cases mit Wordpress-Themes.') }), KW);
    expect(ok).toBe(true);
    expect(warnings.some(w => /Edge Case/.test(w))).toBe(true);
    expect(warnings.some(w => /write "WordPress"/.test(w))).toBe(true);
  });
});
