import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { snippetPage, setMetaFields } = await import('../src/steps/snippet.js');

const TITLE = 'Hochzeit planen: Checkliste für das erste Jahr'; // 46 chars
const GOOD_TITLE = 'Hochzeit planen: die Checkliste für Paare im Jahr'; // 50 chars
const GOOD_DESC = 'Was bis wann zu tun ist: Budget, Location, Gäste und Dienstleister. Mit Zeitplan und Checkliste, damit nichts untergeht.';
const BODY = '\n# Hochzeit planen\n\nEin Absatz, der absichtlich kurz ist und ein paar Regeln des Validators verletzt.\n';
const PAGE = `---\nslug: hochzeit-planen\nmeta_title: "${TITLE}"\nmeta_description: "Alte Beschreibung."\nupdated: "2026-01-01"\n---${BODY}`;
const PAGE_ROW = { slug: 'hochzeit-planen', kind: 'snippet', reason: 'no clicks', queries: [{ query: 'hochzeit planen', position: 3, impressions: 300, clicks: 0 }] };
const CONFIG = { project: 'demo', landing_path: 'content/de/', locale: 'de', locales: ['de'] };

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-snippet-'));
  mkdirSync(join(dir, 'content/de'), { recursive: true });
  writeFileSync(join(dir, 'content/de/hochzeit-planen.md'), PAGE);
  complete.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('setMetaFields', () => {
  it('replaces both fields in place and keeps every other byte', () => {
    const out = setMetaFields(PAGE, { meta_title: 'Neu', meta_description: 'Auch neu' });
    expect(out).toBe(PAGE.replace(`"${TITLE}"`, '"Neu"').replace('"Alte Beschreibung."', '"Auch neu"'));
  });

  it('keeps single quotes and escapes them', () => {
    const md = "---\nmeta_title: 'Alt'\nmeta_description: 'Alt'\n---\nbody";
    expect(setMetaFields(md, { meta_title: "It's new", meta_description: 'x' })).toBe("---\nmeta_title: 'It''s new'\nmeta_description: 'x'\n---\nbody");
  });

  it('refuses a block scalar or a missing field instead of writing something wrong', () => {
    expect(setMetaFields('---\nmeta_title: >-\n  lang\nmeta_description: "x"\n---\nbody', { meta_title: 'a', meta_description: 'b' })).toBeNull();
    expect(setMetaFields('---\nmeta_title: "x"\n---\nbody', { meta_title: 'a', meta_description: 'b' })).toBeNull();
  });
});

describe('snippetPage', () => {
  it('writes only the two fields and is not blocked by defects the page body already had', async () => {
    complete.mockResolvedValue({ meta_title: GOOD_TITLE, meta_description: GOOD_DESC });

    const result = await snippetPage(PAGE_ROW, CONFIG, dir);

    expect(result.failure).toBeUndefined();
    expect(result.markdown.endsWith(BODY)).toBe(true);
    expect(result.markdown).toContain(`meta_title: "${GOOD_TITLE}"`);
    expect(result.before).toEqual({ title: TITLE, description: 'Alte Beschreibung.' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('tries a second time with the feedback when the new title breaks a rule', async () => {
    complete
      .mockResolvedValueOnce({ meta_title: 'x'.repeat(90), meta_description: GOOD_DESC })
      .mockResolvedValueOnce({ meta_title: GOOD_TITLE, meta_description: GOOD_DESC });

    const result = await snippetPage(PAGE_ROW, CONFIG, dir);

    expect(result.markdown).toContain(GOOD_TITLE);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].prompt).toMatch(/failed validation[\s\S]*meta_title too long/);
  });

  it('rejects an em-dash or a transliterated umlaut in a new field even when the body already has the same defect', async () => {
    writeFileSync(join(dir, 'content/de/hochzeit-planen.md'), PAGE.replace('absichtlich kurz', 'absichtlich — kurz fuer'));
    complete.mockResolvedValue({ meta_title: 'Hochzeit planen — die Checkliste für Paare', meta_description: GOOD_DESC.replace('Mit', 'Alles fuer Paare. Mit') });

    const result = await snippetPage(PAGE_ROW, CONFIG, dir);

    expect(result.failure.join(' ')).toMatch(/meta_title: Em-dash/);
    expect(result.failure.join(' ')).toMatch(/meta_description: Umlauts written as ae\/oe\/ue/);
  });

  it('fails after two attempts that both break a rule of the two fields', async () => {
    complete.mockResolvedValue({ meta_title: GOOD_TITLE, meta_description: 'z'.repeat(200) });

    const result = await snippetPage(PAGE_ROW, CONFIG, dir);

    expect(result.failure.some(e => e.startsWith('meta_description too long'))).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('puts the queries into an untrusted block and forbids claims the body does not make', async () => {
    complete.mockResolvedValue({ meta_title: GOOD_TITLE, meta_description: GOOD_DESC });
    await snippetPage(PAGE_ROW, CONFIG, dir);
    const { prompt } = complete.mock.calls[0][0];
    expect(prompt).toMatch(/<<<UNTRUSTED_GSC_START>>>[\s\S]*\| hochzeit planen \| 3\.0 \| 300 \| 0 \|[\s\S]*<<<UNTRUSTED_GSC_END>>>/);
    expect(prompt).toMatch(/Only state what the page body above already states/);
  });
});
