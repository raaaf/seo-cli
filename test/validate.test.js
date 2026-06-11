import { describe, it, expect } from 'vitest';
import { validate } from '../src/steps/validate.js';

const KW = { keyword: 'Webdesign Berlin', expected_entities: [] };

// Exactly 50 words
const TLDR_50 = 'Webdesign Berlin vereint visuelle Gestaltung technische Umsetzung und nutzerzentriertes Denken zu einer kohaerent Einheit. Klare Typografie ausreichend Kontrast und strukturierte Navigation sorgen dafuer dass Besucher ihr Ziel schnell erreichen ohne Ablenkung. Professionelle Agenturen liefern skalierbare Loesungen fuer Unternehmen die im digitalen Raum sichtbar wachsen und konvertieren wollen.';

const FAQ_BLOCK = `faq:
  - q: Was kostet Webdesign Berlin?
    a: Die Kosten liegen zwischen 1000 und 5000 Euro je nach Umfang.
  - q: Wie lange dauert ein Webdesign Projekt?
    a: In der Regel vier bis acht Wochen je nach Feedback-Zyklen.
  - q: Welche Technologien werden genutzt?
    a: HTML CSS und JavaScript sind Standard, oft ergaenzt durch React oder Vue.
  - q: Gibt es laufende Kosten?
    a: Hosting und Wartung fallen monatlich an, typisch 20 bis 80 Euro.`;

function makeBody(extra = '') {
  // Keyword appears once; filler is keyword-free to stay far below the 4% density cap.
  const filler = 'Moderne Webseiten brauchen klare Strukturen schnelle Ladezeiten und verstaendliche Inhalte fuer alle Besucher im digitalen Alltag. ';
  let body = 'Professionelles Webdesign Berlin umfasst visuelle Gestaltung und technische Umsetzung fuer moderne Webseiten. ';
  while (body.split(/\s+/).filter(Boolean).length < 900) body += filler;
  body += 'Konkrete Zahlen: 10 Projekte 20 Kunden 30 Seiten 40 Stunden 50 Iterationen helfen bei der Planung.';
  return extra ? body + ' ' + extra : body;
}

function makeValid(overrides = {}) {
  const body = overrides.body ?? makeBody();
  const tldr = overrides.tldr ?? TLDR_50;
  return `---
slug: webdesign-berlin
meta_title: Webdesign Berlin fuer professionelle Webseiten Projekte
meta_description: Professionelles Webdesign Berlin fuer kleine und mittlere Unternehmen. Moderne Gestaltung, schnelle Umsetzung und klare Struktur fuer mehr Conversions und Sichtbarkeit.
hero:
  headline: Webdesign Berlin fuer moderne Unternehmen
tldr: "${tldr}"
${FAQ_BLOCK}
---
${body}`;
}

describe('validate', () => {
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
