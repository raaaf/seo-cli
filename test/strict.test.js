import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FAQ_BLOCK, makeBody, makeValidPage } from './helpers/valid-page.js';

// `quality: strict`: every rule is off for a standard project and on for a strict one.

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { validate } = await import('../src/steps/validate.js');
const { loadPageBodies, strictValidateOpts } = await import('../src/lib/landings.js');
const { generatePage } = await import('../src/steps/generate.js');
const { improvePage, targetedPage } = await import('../src/steps/improve.js');
const { reviewPage, unresolvedSeverity } = await import('../src/steps/review.js');

const KW = { keyword: 'Webdesign Berlin', expected_entities: [] };
const SOURCES = 'sources:\n  - url: https://example.test/quelle\n    title: Quelle\n';
const FAQ_NO_UNITS = `faq:
  - q: Wie lange dauert ein Webdesign Projekt?
    a: In der Regel vier bis acht Wochen.
  - q: Welche Technologien werden genutzt?
    a: HTML CSS und JavaScript sind Standard.
  - q: Gibt es laufende Kosten?
    a: Hosting und Wartung fallen monatlich an.`;

function page({ body, faq = FAQ_NO_UNITS, sources = '' } = {}) {
  return makeValidPage({ body }).replace(FAQ_BLOCK, sources + faq);
}
const strictOpts = (otherPages = []) => ({ strict: true, otherPages });
const errorsOf = (md, opts) => validate(md, KW, opts).errors;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  complete.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('strict validate', () => {
  const PARAGRAPH = 'Die Rechnung muss Name und Anschrift des leistenden Unternehmers enthalten, dazu eine fortlaufende Rechnungsnummer und das Ausstellungsdatum der Rechnung, sonst ist sie formal unvollständig.';
  const other = [{ slug: 'andere-seite', body: `Einleitung der anderen Seite.\n\n${PARAGRAPH}` }];

  it('rejects a paragraph that repeats a paragraph of another page', () => {
    const errors = errorsOf(page({ body: makeBody(`\n\n${PARAGRAPH}`) }), strictOpts(other));
    expect(errors.some(e => e.startsWith('Duplicate block') && e.includes('andere-seite') && e.includes('Die Rechnung muss'))).toBe(true);
  });

  it('does not flag a paragraph that shares no wording with the other page', () => {
    const unrelated = [{ slug: 'andere-seite', body: 'Ganz andere Worte füllen diesen Absatz ohne jede Überschneidung, damit kein Fünfwortfenster mit dem geprüften Text zusammenfällt und nichts markiert wird.' }];
    const errors = errorsOf(page({ body: makeBody(`\n\n${PARAGRAPH}`) }), strictOpts(unrelated));
    expect(errors.some(e => e.startsWith('Duplicate block'))).toBe(false);
  });

  it('does not compare against a page that was left out of otherPages', () => {
    const errors = errorsOf(page({ body: makeBody(`\n\n${PARAGRAPH}`) }), strictOpts([]));
    expect(errors.some(e => e.startsWith('Duplicate block'))).toBe(false);
  });

  it('rejects more than 6 FAQ entries', () => {
    const faq = 'faq:\n' + Array.from({ length: 7 }, (_, i) => `  - q: Frage ${i}?\n    a: Antwort ${i}.`).join('\n');
    expect(errorsOf(page({ faq }), strictOpts()).some(e => e.startsWith('Too many FAQ entries'))).toBe(true);
  });

  it('rejects a percent or euro figure without link or sources entry', () => {
    const errors = errorsOf(page({ body: makeBody('\n\nDie Umsatzsteuer beträgt 19 % auf den Nettobetrag.') }), strictOpts());
    expect(errors.some(e => e.startsWith('Unsourced number') && e.includes('19 %'))).toBe(true);
  });

  it('accepts such a figure when its paragraph links to a source', () => {
    const body = makeBody('\n\nDie Umsatzsteuer beträgt 19 % auf den Nettobetrag, siehe [UStG](https://example.test/ustg).');
    expect(errorsOf(page({ body }), strictOpts()).some(e => e.startsWith('Unsourced number'))).toBe(false);
  });

  it('accepts such a figure when the frontmatter has a sources entry', () => {
    const body = makeBody('\n\nDie Umsatzsteuer beträgt 19 % auf den Nettobetrag.');
    expect(errorsOf(page({ body, sources: SOURCES }), strictOpts()).some(e => e.startsWith('Unsourced number'))).toBe(false);
  });

  it('drops the minimum digit count', () => {
    const body = makeBody().replace(/\d/g, '');
    expect(errorsOf(page({ body }), strictOpts()).some(e => e.startsWith('Too few digits'))).toBe(false);
    expect(errorsOf(page({ body }), {}).some(e => e.startsWith('Too few digits'))).toBe(true);
  });

  it('leaves a standard project exactly as it was, whatever pages it is handed', () => {
    const md = page({ body: makeBody(`\n\n${PARAGRAPH} Die Umsatzsteuer beträgt 19 %.`) });
    const plain = validate(md, KW);
    expect(validate(md, KW, { otherPages: other })).toEqual(plain);
    expect(validate(md, KW, strictValidateOpts({ quality: 'standard' }, '/nonexistent'))).toEqual(plain);
  });
});

describe('strict page loading', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-strict-'));
    for (const slug of ['a', 'b', 'c']) writeFileSync(join(dir, `${slug}.md`), `---\nslug: ${slug}\n---\nBody of ${slug}`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves out the excluded slugs', () => {
    expect(loadPageBodies(dir, ['a', 'b'])).toEqual([{ slug: 'c', body: 'Body of c' }]);
  });

  it('hands a strict project the other pages and a standard one nothing', () => {
    expect(strictValidateOpts({ quality: 'strict' }, dir, ['a']).otherPages.map(p => p.slug)).toEqual(['b', 'c']);
    expect(strictValidateOpts({}, dir, ['a'])).toEqual({});
  });
});

describe('strict prompts', () => {
  let dir;
  const base = { base_url: 'https://acme.io', locale: 'de', locales: ['de'], landing_path: 'content/landing/de/', site_name: 'Acme', batch_generation: false };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-prompt-'));
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    writeFileSync(join(dir, 'content/landing/de/preise.md'), '---\nslug: preise\n---\nbody');
    complete.mockResolvedValue('---\nslug: preise\n---\nbody');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const generatePrompt = async (config) => {
    await generatePage({ keyword: 'preise', target_slug: 'preise-neu' }, config, dir);
    return complete.mock.calls.at(-1)[0].prompt;
  };
  const improvePrompt = async (config) => {
    await improvePage({ slug: 'preise', kind: 'snippet', reason: 'r', impressions: 1, clicks: 0, bestPosition: 3, queries: [] }, config, dir);
    return complete.mock.calls.at(-1)[0].prompt;
  };

  it('generate: strict requires sources and drops the fixed counts', async () => {
    const prompt = await generatePrompt({ ...base, quality: 'strict' });
    expect(prompt).toContain('`sources:`');
    expect(prompt).not.toContain('Exactly 4–5 H2');
    expect(prompt).not.toContain('Include at least 5 concrete numbers');
    expect(prompt).not.toContain('4–6 entries');
  });

  it('generate: standard keeps the fixed counts and asks for no sources', async () => {
    const prompt = await generatePrompt(base);
    expect(prompt).toContain('- Exactly 4–5 H2 sections, each introduced');
    expect(prompt).toContain('- Include at least 5 concrete numbers/digits (prices, percentages, counts, dates)\n');
    expect(prompt).toContain('faq:           # 4–6 entries from people_also_ask');
    expect(prompt).not.toContain('sources:');
  });

  it('improve: strict drops "existing structure" and requires sources', async () => {
    const prompt = await improvePrompt({ ...base, quality: 'strict' });
    expect(prompt).toContain('- Keep the slug, the frontmatter schema.\n');
    expect(prompt).toContain('`sources:`');
  });

  it('improve: standard keeps "existing structure" and asks for no sources', async () => {
    const prompt = await improvePrompt(base);
    expect(prompt).toContain('- Keep the slug, the frontmatter schema and the existing structure.\n');
    expect(prompt).not.toContain('sources:');
  });
});

describe('strict review', () => {
  let dir;
  const base = { locale: 'de', landing_path: 'content/landing/de/', site_name: 'acme' };
  const FACTS = 'zeit hat keinen Offline-Modus.';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-review-strict-'));
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    mkdirSync(join(dir, 'seo'));
    writeFileSync(join(dir, 'seo/product-facts.md'), FACTS);
    complete.mockResolvedValue({ findings: [] });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reviewPrompt = async (config) => {
    await reviewPage('---\nslug: x\n---\nText', KW, config, dir);
    return complete.mock.calls.at(-1)[0].prompt;
  };

  it('puts the product facts and both severities into the strict prompt', async () => {
    const prompt = await reviewPrompt({ ...base, quality: 'strict' });
    expect(prompt).toContain(FACTS);
    expect(prompt).toMatch(/CONTRADICTS this list is \*\*high\*\*/);
    expect(prompt).toMatch(/ABSENT from this list is \*\*medium\*\*/);
  });

  it('leaves the prompt alone for a standard project, file or not', async () => {
    expect(await reviewPrompt(base)).not.toContain('PRODUCT FACTS');
  });

  it('leaves the prompt alone for a strict project without the file', async () => {
    rmSync(join(dir, 'seo/product-facts.md'));
    expect(await reviewPrompt({ ...base, quality: 'strict' })).not.toContain('PRODUCT FACTS');
  });

  it('discards on an unfixed contradiction and only warns on an absent claim', async () => {
    const finding = (severity) => ({ severity, quote: 'Text', problem: 'p', replacement: null });
    complete.mockResolvedValueOnce({ findings: [finding('high')] }).mockResolvedValueOnce({ findings: [finding('medium')] });

    const contradiction = await reviewPage('---\nslug: x\n---\nText', KW, { ...base, quality: 'strict' }, dir);
    const absent = await reviewPage('---\nslug: x\n---\nText', KW, { ...base, quality: 'strict' }, dir);

    expect(unresolvedSeverity(contradiction.findings)).toBe('high');
    expect(unresolvedSeverity(absent.findings)).toBeNull();
  });
});

describe('targetedPage', () => {
  let dir;
  const config = { locale: 'de', locales: ['de'], landing_path: 'content/landing/de/' };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-targeted-'));
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    for (const slug of ['ziel', 'quelle']) writeFileSync(join(dir, `content/landing/de/${slug}.md`), `---\nslug: ${slug}\n---\nText von ${slug}`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('feeds brief and merged pages to the diagnosis', () => {
    const page = targetedPage({ slug: 'ziel', mergeFrom: ['quelle'], brief: 'Rechtsfehler beheben' }, config, dir);
    expect(page.diagnosis).toContain('Rechtsfehler beheben');
    expect(page.diagnosis).toContain('Text von quelle');
    expect(page.mergeFrom).toEqual(['quelle']);
  });

  it('refuses a missing page and a self-merge', () => {
    expect(() => targetedPage({ slug: 'nope' }, config, dir)).toThrow(/not found/);
    expect(() => targetedPage({ slug: 'ziel', mergeFrom: ['ziel'] }, config, dir)).toThrow(/must not contain/);
  });
});
