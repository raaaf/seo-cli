import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { judgeLinkSources } = await import('../src/steps/link-judge.js');
const { buildInboundLinkFiles, tryInboundLinkFiles } = await import('../src/lib/landings.js');
const { MODELS } = await import('../src/lib/models.js');

const target = { slug: 'taufe-planen', title: 'Taufe planen', description: 'Alles zur Taufe' };
const cand = (slug) => ({ slug, title: `Titel ${slug}`, description: `Beschreibung ${slug}` });
const verdict = (...entries) => ({ judgments: entries.map(([slug, score, reason = 'same need']) => ({ slug, score, reason })) });

beforeEach(() => { complete.mockReset(); });

describe('judgeLinkSources', () => {
  it('keeps only score 2, in input order, and passes the reason on', async () => {
    complete.mockResolvedValue(verdict(['b', 2, 'same family event'], ['a', 1], ['c', 2]));
    const picks = await judgeLinkSources({ target, candidates: [cand('a'), cand('b'), cand('c')] });
    expect(picks).toEqual([{ slug: 'b', reason: 'same family event' }, { slug: 'c', reason: 'same need' }]);
  });

  it('drops slugs that are not in the candidate list', async () => {
    complete.mockResolvedValue(verdict(['ghost', 2], ['a', 2]));
    expect((await judgeLinkSources({ target, candidates: [cand('a')] })).map(p => p.slug)).toEqual(['a']);
  });

  it('returns at most max picks', async () => {
    complete.mockResolvedValue(verdict(['a', 2], ['b', 2], ['c', 2]));
    expect(await judgeLinkSources({ target, candidates: [cand('a'), cand('b'), cand('c')], max: 2 })).toHaveLength(2);
  });

  it('cuts the reason to 8 words', async () => {
    complete.mockResolvedValue(verdict(['a', 2, 'one two three four five six seven eight nine ten']));
    const [pick] = await judgeLinkSources({ target, candidates: [cand('a')] });
    expect(pick.reason).toBe('one two three four five six seven eight');
  });

  it('asks the cheap model with the candidates in the prompt, and not at all without candidates', async () => {
    complete.mockResolvedValue(verdict(['a', 2]));
    await judgeLinkSources({ target, candidates: [cand('a')] });
    expect(complete.mock.calls[0][0]).toMatchObject({ model: MODELS.judge, json: true });
    expect(complete.mock.calls[0][0].prompt).toContain('a | Titel a | Beschreibung a');
    complete.mockClear();
    expect(await judgeLinkSources({ target, candidates: [] })).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('treats an omitted candidate as score 0 without a warning, and tells the model to omit them', async () => {
    complete.mockResolvedValue(verdict(['a', 2]));
    const warnings = [];
    const picks = await judgeLinkSources({ target, candidates: [cand('a'), cand('b')] }, w => warnings.push(w));
    expect(picks.map(p => p.slug)).toEqual(['a']);
    expect(warnings).toEqual([]);
    expect(complete.mock.calls[0][0].prompt).toMatch(/omit every candidate scoring 0/);
  });

  it('sizes max tokens by the number of candidates, capped at 8000', async () => {
    complete.mockResolvedValue(verdict());
    await judgeLinkSources({ target, candidates: [cand('a'), cand('b')] });
    expect(complete.mock.calls[0][0].maxTokens).toBe(256 + 48 * 2);
    complete.mockClear();
    await judgeLinkSources({ target, candidates: Array.from({ length: 400 }, (_, i) => cand(`p${i}`)) });
    expect(complete.mock.calls[0][0].maxTokens).toBe(8000);
  });

  it('prefers the candidate with fewer related_pages among the 2s', async () => {
    complete.mockResolvedValue(verdict(['a', 2], ['b', 2], ['c', 2]));
    const picks = await judgeLinkSources({ target, candidates: [{ ...cand('a'), related: 3 }, { ...cand('b'), related: 0 }, { ...cand('c'), related: 3 }], max: 2 });
    expect(picks.map(p => p.slug)).toEqual(['b', 'a']);
  });

  it('retries once on invalid JSON and uses the second answer', async () => {
    complete.mockRejectedValueOnce(new Error('Claude returned no JSON:\nsorry')).mockResolvedValueOnce(verdict(['a', 2]));
    const picks = await judgeLinkSources({ target, candidates: [cand('a')] });
    expect(picks.map(p => p.slug)).toEqual(['a']);
    expect(complete.mock.calls[1][0].prompt).toMatch(/not valid JSON/);
  });

  it('returns no links and a warning after invalid JSON twice', async () => {
    complete.mockRejectedValue(new Error('Claude returned malformed JSON: x'));
    const warnings = [];
    expect(await judgeLinkSources({ target, candidates: [cand('a')] }, w => warnings.push(w))).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(warnings[0]).toMatch(/taufe-planen/);
  });

  it('lets other errors through', async () => {
    complete.mockRejectedValue(new Error('Anthropic monthly budget exhausted'));
    await expect(judgeLinkSources({ target, candidates: [cand('a')] })).rejects.toThrow('budget');
  });
});

describe('buildInboundLinkFiles', () => {
  let dir;
  const config = { landing_path: 'content/landing/de/', locale: 'de', locales: ['de'] };
  const md = (related = []) => `---\nmeta_title: T\nmeta_description: D\n${related.length ? `related_pages:\n${related.map(s => `  - ${s}`).join('\n')}\n` : ''}---\nbody`;
  const write = (slug, markdown = md()) => {
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    writeFileSync(join(dir, 'content/landing/de', `${slug}.md`), markdown);
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-inbound-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sends only eligible pages to the judge', async () => {
    write('links-already', md(['taufe-planen']));
    write('related-full', md(['s-a', 's-b', 's-c', 's-d']));
    write('excluded');
    write('eligible');
    complete.mockResolvedValue(verdict(['eligible', 2]));

    await buildInboundLinkFiles({ targets: [target], config, cwd: dir, exclude: ['excluded'] });

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('eligible | T | D');
    for (const slug of ['links-already', 'related-full', 'excluded']) expect(prompt).not.toContain(`${slug} |`);
  });

  it('never sends a page addRelatedPage cannot edit to the judge', async () => {
    write('inline-list', '---\nmeta_title: T\nrelated_pages: [a, b]\n---\nbody');
    write('crlf', '---\r\nmeta_title: T\r\n---\r\nbody');
    write('plain');
    complete.mockResolvedValue(verdict(['plain', 2]));

    await buildInboundLinkFiles({ targets: [target], config, cwd: dir });

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('plain | T | D');
    expect(prompt).not.toContain('inline-list |');
    expect(prompt).not.toContain('crlf |');
  });

  it('returns one file entry per source even when it is picked for several targets', async () => {
    write('ablauf');
    complete.mockResolvedValue(verdict(['ablauf', 2, 'same event']));
    const { files, links } = await buildInboundLinkFiles({ targets: [target, { ...target, slug: 'kommunion-planen' }], config, cwd: dir });

    expect(links).toEqual([
      { source: 'ablauf', target: 'taufe-planen', reason: 'same event' },
      { source: 'ablauf', target: 'kommunion-planen', reason: 'same event' },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(join('content/landing/de/', 'ablauf.md'));
    expect(files[0].content).toContain('  - taufe-planen\n  - kommunion-planen\n');
  });

  it('leaves the files alone when the judge finds nothing on topic', async () => {
    write('ablauf');
    complete.mockResolvedValue(verdict(['ablauf', 1]));
    const { files } = await buildInboundLinkFiles({ targets: [target], config, cwd: dir });
    expect(files).toEqual([]);
    expect(readFileSync(join(dir, 'content/landing/de/ablauf.md'), 'utf8')).toBe(md());
  });

  it('tryInboundLinkFiles turns a judge error into a warning and no files', async () => {
    write('ablauf');
    complete.mockRejectedValue(new Error('API down'));
    const warnings = [];
    expect(await tryInboundLinkFiles({ targets: [target], config, cwd: dir }, w => warnings.push(w))).toEqual({ files: [], links: [] });
    expect(warnings[0]).toMatch(/API down/);
  });
});
