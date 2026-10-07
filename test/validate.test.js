import { describe, it, expect } from 'vitest';
import { validate, findTransliteratedUmlauts } from '../src/steps/validate.js';
import { makeCatalog } from './helpers/catalog.js';
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

  it("treats a possessive 's in the headline as matching the keyword without it", () => {
    const md = makeValid().replace('Webdesign Berlin fuer moderne Unternehmen', "New Year's party ideas");
    const { warnings } = validate(md, { keyword: 'new years party', expected_entities: [] });
    expect(warnings.some(w => w.startsWith('hero.headline'))).toBe(false);
  });

  it("treats a trailing plural possessive s' in the keyword as matching the headline without it", () => {
    const md = makeValid().replace('Webdesign Berlin fuer moderne Unternehmen', 'Kids birthday ideas');
    const { warnings } = validate(md, { keyword: "kids\u2019 birthday", expected_entities: [] });
    expect(warnings.some(w => w.startsWith('hero.headline'))).toBe(false);
  });

  it('matches an ASCII keyword against the umlaut spelling in the headline', () => {
    const md = makeValid().replace('Webdesign Berlin fuer moderne Unternehmen', 'Webdesign Fürth für Gründer');
    const { warnings } = validate(md, { keyword: 'webdesign fuerth', expected_entities: [] });
    expect(warnings.some(w => w.startsWith('hero.headline'))).toBe(false);
  });

  it('matches an umlaut keyword against the ASCII spelling in the headline', () => {
    const md = makeValid().replace('Webdesign Berlin fuer moderne Unternehmen', 'Webdesign fuerth Preise');
    const { warnings } = validate(md, { keyword: 'Webdesign Fürth', expected_entities: [] });
    expect(warnings.some(w => w.startsWith('hero.headline'))).toBe(false);
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
    // Both bounds in the message: a retry that only sees "min 40" overshoots to 64, one that only sees "max 60" undershoots to 38.
    expect(errors.find(e => e.includes('tldr too short'))).toMatch(/need 40-60/);
  });

  it('errors when tldr is too long', () => {
    // TLDR_50 (50 words) + 14 more = 64 words, above the 60-word limit
    const longTldr = TLDR_50 + ' Zusaetzlich profitieren Teams von messbaren Ergebnissen klaren Prozessen und einer Struktur die langfristig traegt.';
    const { errors } = validate(makeValid({ tldr: longTldr }), KW);
    expect(errors.some(e => e.includes('tldr too long'))).toBe(true);
    expect(errors.find(e => e.includes('tldr too long'))).toMatch(/need 40-60/);
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

describe('validate-page: counterpart mode ({ counterpart: true })', () => {
  // The source keyword is German; a counterpart page is an English adaptation
  // and never contains it, so keyword/entity checks must not fire on it.
  const KW_DE = { keyword: 'Firmenfeier planen', expected_entities: ['Cateringservice'] };

  it('skips German-specific denylist/stale-fact warnings on a counterpart page', () => {
    const { ok, warnings } = validate(makeValid({ body: makeBody('Export direkt nach lexoffice und sevDesk.') }), KW_DE, { counterpart: true });
    expect(ok).toBe(true);
    expect(warnings.some(w => /Lexware Office/.test(w))).toBe(false);
  });

  it('skips keyword-presence and entity-coverage warnings on a counterpart page', () => {
    const { ok, warnings } = validate(makeValid(), KW_DE, { counterpart: true });
    expect(ok).toBe(true);
    expect(warnings.some(w => /target keyword/.test(w))).toBe(false);
    expect(warnings.some(w => /not fully present in body/.test(w))).toBe(false);
    expect(warnings.some(w => /Entity coverage/.test(w))).toBe(false);
  });

  it('still applies keyword/entity checks when counterpart is not set (default)', () => {
    const { warnings } = validate(makeValid(), KW_DE);
    expect(warnings.some(w => /Entity coverage/.test(w))).toBe(true);
  });

  it('still warns on brand casing on a counterpart page', () => {
    const { warnings } = validate(makeValid({ body: makeBody('Built with Wordpress and a custom theme.') }), KW_DE, { counterpart: true });
    expect(warnings.some(w => /write "WordPress"/.test(w))).toBe(true);
  });

  it('still enforces structural checks (body word count, meta lengths) on a counterpart page', () => {
    const md = `---
slug: test
meta_title: Company Event Planning for Modern Teams and Groups
meta_description: A short guide to planning company events, covering venue booking, catering and budget considerations for teams of any size and budget.
hero:
  headline: Plan your next company event
tldr: "${TLDR_50}"
${FAQ_BLOCK}
---
Too short body.`;
    const { ok, errors } = validate(md, KW_DE, { counterpart: true });
    expect(ok).toBe(false);
    expect(errors.some(e => e.includes('Body too short'))).toBe(true);
  });
});

describe('transliterated umlauts', () => {
  it('flags a word the page itself also spells with the umlaut', () => {
    // The W34 case: heading "Nachtraege", paragraph below "Nachträge".
    expect(findTransliteratedUmlauts('## Nachtraege regeln\n\nNachträge sind der Konfliktpunkt.'))
      .toEqual(['Nachtraege']);
  });

  it('flags known forms even when the umlaut spelling is absent', () => {
    expect(findTransliteratedUmlauts('Das ist fuer alle moeglich.').sort()).toEqual(['fuer', 'moeglich']);
  });

  it('leaves German words that legitimately contain ae, oe or ue alone', () => {
    expect(findTransliteratedUmlauts('Aktuelle Quelle, neue Steuer, Museum, Abenteuer, Bauer, Poesie.')).toEqual([]);
  });

  it('ignores words that come from a slug, which has to stay ASCII', () => {
    expect(findTransliteratedUmlauts('freelancer-webdesign-fuerth', new Set(['fuerth']))).toEqual([]);
  });

  it('reports each offender once', () => {
    expect(findTransliteratedUmlauts('fuer und fuer und FUER')).toEqual(['fuer']);
  });
});

describe('validate-page: page contract', () => {
  const CONTRACT = {
    body_words: [300, 600],
    require: ['products'],
    forbid: ['steps', 'checklist'],
    products: { min: 3, max: 8, max_overlap: 0.6 },
    lowercase: true,
    meta_title_suffix: ' . punkt und pause',
    facts_denylist: ['\\d+([,.]\\d+)?\\s*(€|eur|euro)', '\\d+\\s*(bis|-)?\\s*\\d*\\s*(werktage|tage|wochen)', '(bio|organic|nachhaltig\\w*)'],
  };
  const catalog = makeCatalog();
  const filler = 'moderne shirts brauchen klare motive und gute passform fuer jeden tag im alltag. ';
  const body = (words = 400) => filler.repeat(Math.ceil(words / 13)).split(' ').slice(0, words).join(' ') + ' 10 20 30 40 50';

  // The shared FAQ fixture names prices, which the denylist rightly rejects.
  const FAQ_PLAIN = `faq:
  - q: passt die groesse?
    a: die shirts fallen normal aus.
  - q: wie wasche ich sie?
    a: bei dreissig grad im schonwaschgang.
  - q: kann ich tauschen?
    a: ja, schreib uns einfach kurz.`;

  // A lowercase page that satisfies CONTRACT; `fm` adds frontmatter lines, `from`/`to` patch the markdown.
  function page({ products = ['tanz-mit-mir', 'nachteule', 'kaffee-first'], fm = '', bodyText = body(), title = 'geschenke fuer nachteulen und kaffeefans' } = {}) {
    const list = products === null ? '' : `products: [${products.join(', ')}]\n`;
    return makeValid({ body: bodyText, tldr: TLDR_50.toLowerCase() })
      .toLowerCase()
      .replace(/^meta_title: .*$/m, `meta_title: ${title}`)
      .replace(/faq:[\s\S]*?(?=\n---)/, FAQ_PLAIN)
      .replace('hero:', `${list}${fm}hero:`);
  }
  const run = (md, extra = {}) => validate(md, KW, { contract: CONTRACT, catalog, ...extra });

  it('passes a page that satisfies the contract', () => {
    const { ok, errors } = run(page());
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('uses the contract word range instead of 800 to 1400', () => {
    expect(run(page({ bodyText: body(200) })).errors.some(e => /Body too short: \d+ words \(min 300\)/.test(e))).toBe(true);
    expect(run(page({ bodyText: body(700) })).errors.some(e => /Body too long: \d+ words \(max 600\)/.test(e))).toBe(true);
  });

  it('requires the configured fields', () => {
    expect(run(page({ products: null })).errors).toContain('Missing frontmatter field: products');
  });

  it('rejects forbidden fields', () => {
    const { errors } = run(page({ fm: 'steps: [a]\n' }));
    expect(errors).toContain('Forbidden frontmatter field (page contract): steps');
  });

  it('enforces the product count range', () => {
    expect(run(page({ products: ['nachteule', 'sonntag'] })).errors.some(e => e.startsWith('Too few products: 2'))).toBe(true);
    const nine = Array.from({ length: 9 }, (_, i) => `p${i}`);
    expect(validate(page({ products: nine }), KW, { contract: CONTRACT }).errors.some(e => e.startsWith('Too many products: 9'))).toBe(true);
  });

  it('rejects product slugs missing from the catalog', () => {
    const { errors } = run(page({ products: ['nachteule', 'sonntag', 'gibt-es-nicht'] }));
    expect(errors).toContain('Products not in the catalog: gibt-es-nicht');
  });

  it('rejects too much product overlap with an existing page', () => {
    const existingPages = [{ slug: 'andere-seite', products: ['tanz-mit-mir', 'nachteule', 'kaffee-first'] }];
    expect(run(page(), { existingPages }).errors.some(e => e.startsWith('Product overlap with "andere-seite"'))).toBe(true);
  });

  it('accepts overlap within the limit and ignores the page itself', () => {
    const within = [{ slug: 'andere-seite', products: ['tanz-mit-mir', 'regenbogen'] }];
    expect(run(page(), { existingPages: within }).ok).toBe(true);
    const itself = [{ slug: 'webdesign-berlin', products: ['tanz-mit-mir', 'nachteule', 'kaffee-first'] }];
    expect(run(page(), { existingPages: itself }).ok).toBe(true);
  });

  it('rejects uppercase letters and names the fields', () => {
    const md = page().replace('geschenke fuer nachteulen', 'Geschenke fuer nachteulen').replace('moderne shirts', 'Moderne shirts');
    const { errors } = run(md);
    const msg = errors.find(e => e.startsWith('Uppercase letters'));
    expect(msg).toContain('meta_title');
  });

  it('checks body headings for lowercase', () => {
    const { errors } = run(page({ bodyText: `## ein titel\n\n${body()}` }).replace('## ein titel', '## Ein Titel'));
    expect(errors.find(e => e.startsWith('Uppercase letters'))).toContain('heading 1');
  });

  it('lowers the meta_title limit by the brand suffix', () => {
    const title = 'geschenke fuer nachteulen und kaffeefans heute'; // 46 chars, fine without suffix
    expect(run(page({ title: title + 'xx' })).errors.some(e => /meta_title too long \(48 chars, max 47\)/.test(e))).toBe(true);
    expect(run(page({ title })).errors).toEqual([]);
  });

  it('fails a claim the catalog does not back', () => {
    const { errors } = run(page({ bodyText: `${body()} kostet nur 19,99 euro.` }));
    expect(errors.some(e => e.startsWith('Claim not backed by the catalog') && e.includes('19,99 eur'))).toBe(true);
  });

  it('allows a denylisted phrase that stands word for word in the catalog', () => {
    expect(run(page({ bodyText: `${body()} die lieferung dauert 5 bis 10 werktage.` })).errors).toEqual([]);
  });

  it('reports an invalid denylist pattern instead of crashing', () => {
    const { errors } = validate(page(), KW, { contract: { facts_denylist: ['('] } });
    expect(errors).toContain('Invalid facts_denylist pattern: (');
  });

  it('rejects a reserved slug', () => {
    const md = page().replace('slug: webdesign-berlin', 'slug: admin');
    expect(run(md, { reservedSlugs: ['admin', 'up'] }).errors).toContain('Slug "admin" is a reserved path of the site');
  });

  it('applies no contract rules without a contract', () => {
    const { errors } = validate(makeValid().replace('hero:', 'steps: [a]\nhero:'), KW);
    expect(errors).toEqual([]);
  });
});
