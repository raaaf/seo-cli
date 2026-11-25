import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { questionKind, questionGaps, pickQuestionPage } = await import('../src/lib/questions.js');
const { setFaqEntries, answerQuestions, faqMax } = await import('../src/steps/questions.js');
const { parseFrontmatter } = await import('../src/lib/frontmatter.js');
const { buildQueue } = await import('../src/lib/queue.js');

const q = (query, position, impressions, clicks = 0) => ({ query, position, impressions, clicks });

describe('questionKind', () => {
  it('finds German and English questions by their first word, umlauts included', () => {
    expect(questionKind('wie viel kostet ein abiball')).toBe('question');
    expect(questionKind('würde sich ein poster lohnen')).toBe('question');
    expect(questionKind('wuerde sich ein poster lohnen')).toBe('question');
    expect(questionKind('welches geschenk für die freundin')).toBe('question');
    expect(questionKind('how much does a website cost')).toBe('question');
    expect(questionKind('abiball location?')).toBe('question');
  });

  it('finds purchase intent anywhere, by stem or whole word', () => {
    expect(questionKind('website erstellen fürth preise')).toBe('purchase');
    expect(questionKind('günstige poster kaufen')).toBe('purchase');
    expect(questionKind('event app erfahrungen')).toBe('purchase');
    expect(questionKind('beste event app')).toBe('purchase');
  });

  it('leaves plain keywords and look-alikes alone', () => {
    expect(questionKind('abiball organisieren')).toBeNull();
    expect(questionKind('kaufland öffnungszeiten')).toBeNull();
    expect(questionKind('bis was uhr')).toBeNull();
    expect(questionKind('testament vorlage')).toBeNull();
    expect(questionKind('')).toBeNull();
  });
});

describe('questionGaps', () => {
  it('keeps question queries within reach that lose the click, by impressions', () => {
    const gaps = questionGaps([
      q('was kostet ein abiball', 6, 120, 0),
      q('abiball organisieren', 4, 900, 2), // no question
      q('wie lange dauert ein abiball', 35, 300, 0), // out of reach
      q('wann abiball planen', 5, 5, 0), // too few impressions
      q('abiball kosten', 3, 200, 40), // clicked as expected
      q('abiball preise', 8, 60, 0),
    ]);
    expect(gaps.map(g => g.query)).toEqual(['was kostet ein abiball', 'abiball preise']);
    expect(gaps[1].kind).toBe('purchase');
  });
});

describe('pickQuestionPage', () => {
  const page = (slug, queries) => [slug, { slug, impressions: 0, clicks: 0, bestPosition: 1, queries }];

  it('ranks pages by the impressions of their gap queries and honours cooldown, exclude and skip', () => {
    const bySlug = new Map([
      page('a', [q('was kostet a', 5, 50)]),
      page('b', [q('was kostet b', 5, 80), q('wie geht b', 7, 40)]),
      page('c', [q('wie geht c', 5, 30)]), // below the page floor
      page('d', [q('was kostet d', 5, 500)]),
    ]);
    const picks = pickQuestionPage({ bySlug, config: { exclude_slugs: ['d'] }, limit: 3 });
    expect(picks.map(p => p.slug)).toEqual(['b', 'a']);
    expect(picks[0]).toMatchObject({ kind: 'faq', score: 120 });
    expect(picks[0].questions).toHaveLength(2);
    expect(pickQuestionPage({ bySlug, cooldown: new Set(['b', 'd']), skip: ['a'] })).toBeNull();
  });
});

const FAQ_PAGE = [
  '---',
  'slug: abiball-organisieren',
  'meta_title: "Abiball organisieren"',
  'faq:',
  '  - q: "Wann anfangen?"',
  '    a: "Zehn bis zwölf Monate vorher."',
  '  - q: "Wer organisiert?"',
  '    a: "Das Abikomitee."',
  'related_pages:',
  '  - abitreffen-organisieren',
  '---',
  '',
  '# Abiball organisieren',
  '',
  'Text.',
  '',
].join('\n');

describe('setFaqEntries', () => {
  it('appends and replaces entries as text and keeps every other line', () => {
    const out = setFaqEntries(FAQ_PAGE, [
      { replaces: -1, q: 'Was kostet ein Abiball?', a: 'Rechnet mit 60 bis 120 Euro "pro" Person.' },
      { replaces: 1, q: 'Wer plant den Abiball?', a: 'Das Abikomitee des Jahrgangs.' },
    ]);
    const faq = parseFrontmatter(out).parsed.faq;
    expect(faq).toEqual([
      { q: 'Wann anfangen?', a: 'Zehn bis zwölf Monate vorher.' },
      { q: 'Wer plant den Abiball?', a: 'Das Abikomitee des Jahrgangs.' },
      { q: 'Was kostet ein Abiball?', a: 'Rechnet mit 60 bis 120 Euro "pro" Person.' },
    ]);
    expect(out.split('---\n').at(-1)).toBe(FAQ_PAGE.split('---\n').at(-1));
    expect(out).toContain('related_pages:\n  - abitreffen-organisieren');
  });

  it('refuses a faq list it cannot edit safely', () => {
    expect(setFaqEntries('---\nfaq: []\n---\nbody', [{ replaces: -1, q: 'a', a: 'b' }])).toBeNull();
    expect(setFaqEntries('---\nslug: x\n---\nbody', [{ replaces: -1, q: 'a', a: 'b' }])).toBeNull();
    expect(setFaqEntries('---\nfaq:\n  -\n    q: "x"\n    a: "y"\n---\nbody', [{ replaces: -1, q: 'a', a: 'b' }])).toBeNull();
  });
});

describe('faqMax', () => {
  it('is the strict cap under quality: strict', () => {
    expect(faqMax({ quality: 'strict' })).toBe(6);
    expect(faqMax({})).toBe(8);
  });
});

describe('answerQuestions', () => {
  let dir;
  const CONFIG = { project: 'demo', landing_path: 'content/de/', locale: 'de', locales: ['de'], counterpart_locale: 'en', fact_check: false };
  const PAGE = { slug: 'abiball-organisieren', reason: 'r', queries: [q('was kostet ein abiball', 6, 120)], questions: [{ ...q('was kostet ein abiball', 6, 120), kind: 'question' }] };
  const EN = FAQ_PAGE.replace('slug: abiball-organisieren', 'slug: prom-night').replace('Wann anfangen?', 'When to start?').replace('Wer organisiert?', 'Who organises?');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-questions-'));
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    mkdirSync(join(dir, 'content/en'), { recursive: true });
    writeFileSync(join(dir, 'content/de/abiball-organisieren.md'), FAQ_PAGE.replace('slug: abiball-organisieren', 'slug: abiball-organisieren\nalternate: prom-night'));
    writeFileSync(join(dir, 'content/en/prom-night.md'), EN);
    complete.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the entry to the page and the counterpart at the same place', async () => {
    complete.mockResolvedValue({
      entries: [{ queries: ['was kostet ein abiball'], replaces: -1, q: 'Was kostet ein Abiball?', a: 'Das hängt vom Jahrgang ab.', counterpart_q: 'What does a prom cost?', counterpart_a: 'It depends on the year group.' }],
      skipped: [],
    });
    const result = await answerQuestions(PAGE, CONFIG, dir);
    expect(result.failure).toBeUndefined();
    expect(parseFrontmatter(result.markdown).parsed.faq.at(-1).q).toBe('Was kostet ein Abiball?');
    expect(result.counterpart.filePath).toBe(join('content/en', 'prom-night.md'));
    expect(parseFrontmatter(result.counterpart.markdown).parsed.faq.at(-1).q).toBe('What does a prom cost?');
    expect(complete.mock.calls[0][0].prompt).toContain('<<<UNTRUSTED_GSC_START>>>');
  });

  it('retries with the validator feedback, then gives up', async () => {
    complete.mockResolvedValue({
      entries: [{ queries: ['x'], replaces: -1, q: 'Was kostet ein Abiball?', a: 'Es kommt drauf an — immer.', counterpart_q: 'a', counterpart_a: 'b' }],
      skipped: [],
    });
    const result = await answerQuestions(PAGE, CONFIG, dir);
    expect(result.failure.length).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].prompt).toContain('failed validation');
  });

  it('returns none when every query was skipped', async () => {
    complete.mockResolvedValue({ entries: [], skipped: [{ query: 'was kostet ein abiball', reason: 'kein Preis auf der Seite' }] });
    const result = await answerQuestions(PAGE, CONFIG, dir);
    expect(result).toEqual({ none: true, skipped: [{ query: 'was kostet ein abiball', reason: 'kein Preis auf der Seite' }] });
  });
});

describe('queue', () => {
  it('lets a faq pick merge by itself and holds it under the brake', () => {
    const c = { type: 'faq', slug: 'a', source: 'gsc', why: 'w', score: 100, touches: ['a'] };
    const { queue } = buildQueue({ candidates: [c], today: '2026-11-25' });
    expect(queue[0].status).toBe('selected');
    const braked = buildQueue({
      candidates: [c], today: '2026-11-25',
      alerts: [{ id: 'traffic_drop', since: '2026-11-15' }], changes: [{ merged_at: '2026-11-01' }],
    });
    expect(braked.queue[0]).toMatchObject({ status: 'blocked', reason: 'brake' });
  });
});

describe('collectCandidates', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-questions-queue-'));
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    writeFileSync(join(dir, 'content/de/abiball-organisieren.md'), FAQ_PAGE);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = { project: 'demo', landing_path: 'content/de/', locale: 'de', locales: ['de'], base_url: 'https://example.com', merge_proposals: false, prune_proposals: false };
  const rows = [{ url: 'https://example.com/abiball-organisieren', query: 'was kostet ein abiball', position: 6, impressions: 120, clicks: 0 }];

  it('adds a faq candidate also in a week that generates pages, and none with question_faq: false', async () => {
    const { collectCandidates } = await import('../src/steps/queue.js');
    const toGenerate = [{ keyword: 'abiparty', target_slug: 'abiparty-organisieren' }];
    const out = await collectCandidates({ config, cwd: dir, toGenerate, fetchRows: async () => rows });
    expect(out.find(c => c.type === 'faq')).toMatchObject({ slug: 'abiball-organisieren', pick: { kind: 'faq' }, touches: ['abiball-organisieren'] });
    const off = await collectCandidates({ config: { ...config, question_faq: false }, cwd: dir, toGenerate, fetchRows: async () => { throw new Error('not called'); } });
    expect(off.some(c => c.type === 'faq')).toBe(false);
  });
});
