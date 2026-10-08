import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { assessAlerts, internalLinks } = await import('../src/steps/assess.js');
const { BudgetExceededError } = await import('../src/lib/budget.js');

const CONFIG = { base_url: 'https://a.de', locales: ['de'], site_name: 'A' };
const TODAY = '2026-10-08';
const url = (slug) => `https://a.de/${slug}`;
const diagnosis = (slug, cause = 'clean') => ({ checked_at: '2026-10-01', cause, codes: [], urls: [{ url: url(slug), cause, findings: [] }] });
const deindexed = (slug, extra = {}) => ({ id: `deindexed:${url(slug)}`, kind: 'deindexed', since: '2026-10-01', detail: url(slug), diagnosis: diagnosis(slug), ...extra });
const site = (extra = {}) => ({ id: 'site_not_indexed', kind: 'site_not_indexed', since: '2026-10-01', detail: {}, diagnosis: diagnosis('p'), ...extra });
const answer = { likely_causes: ['Thin pages'], actions: [{ action: 'Add depth', why: 'Pages are short' }] };
const page = async () => ({ status: 200, finalUrl: url('p'), headers: {}, html: '<html><body>Some page text</body></html>' });

let dir;
const seed = (open) => {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, 'seo/alerts.json'), JSON.stringify({ version: 1, open, known_indexed: [], traffic_pending: null, failures: 0 }));
};
const saved = () => JSON.parse(readFileSync(join(dir, 'seo/alerts.json'), 'utf8')).open;
const crawledAfterChanges = () => writeFileSync(join(dir, 'seo/index-status.json'), JSON.stringify({ version: 1, updated: TODAY, entries: [{ url: url('a'), coverageState: 'Crawled - currently not indexed', lastCrawlTime: '2026-10-02T00:00:00Z' }] }));
const assess = (extra = {}) => { const warnings = []; return assessAlerts({ config: CONFIG, cwd: dir, today: TODAY, fetch: page, gitLog: () => '', inspect: async urls => urls.map(u => ({ url: u, coverageState: 'unknown', lastCrawlTime: null })), warnings, ...extra }).then(done => ({ done, warnings })); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-assess-'));
  complete.mockReset();
  complete.mockResolvedValue(answer);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('assess', () => {
  it('assesses only alerts whose diagnosis is clean', async () => {
    seed([deindexed('a', { diagnosis: diagnosis('a', 'technical') }), deindexed('b', { diagnosis: diagnosis('b', 'unknown') }), deindexed('c', { diagnosis: undefined }), deindexed('d')]);

    const { done } = await assess();

    expect(done.map(d => d.alert_id)).toEqual([`deindexed:${url('d')}`]);
    expect(saved().find(a => a.detail === url('d')).assessment).toMatchObject({ assessed_at: TODAY, likely_causes: ['Thin pages'] });
    expect(saved().find(a => a.detail === url('a')).assessment).toBeUndefined();
  });

  it('skips an assessment younger than 28 days and redoes one that is 28 days old', async () => {
    seed([
      deindexed('fresh', { assessment: { assessed_at: '2026-09-11', likely_causes: [], actions: [] } }),
      deindexed('stale', { assessment: { assessed_at: '2026-09-10', likely_causes: [], actions: [] } }),
    ]);

    const { done } = await assess();

    expect(done.map(d => d.alert_id)).toEqual([`deindexed:${url('stale')}`]);
  });

  it('takes site_not_indexed first and at most 3 per run', async () => {
    seed([deindexed('a'), deindexed('b'), deindexed('c'), site()]);

    const { done } = await assess();

    expect(done.map(d => d.alert_id)).toEqual(['site_not_indexed', `deindexed:${url('a')}`, `deindexed:${url('b')}`]);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('treats a result without actions as a failed assessment, nothing saved', async () => {
    seed([deindexed('a')]);
    complete.mockResolvedValue({ likely_causes: ['x'], actions: [] });

    const { done, warnings } = await assess();

    expect(done).toEqual([]);
    expect(saved()[0].assessment).toBeUndefined();
    expect(warnings[0]).toMatch(/Assessment failed for deindexed:/);
  });

  it('skips an alert with the no_text hint without a call and warns', async () => {
    const noText = { ...diagnosis('a'), urls: [{ url: url('a'), cause: 'clean', findings: [{ code: 'no_text' }] }], codes: ['no_text'] };
    seed([deindexed('a', { diagnosis: noText }), deindexed('b')]);

    const { done, warnings } = await assess();

    expect(done.map(d => d.alert_id)).toEqual([`deindexed:${url('b')}`]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([expect.stringContaining(`deindexed:${url('a')}`)]);
  });

  it('prints but saves nothing on a dry run', async () => {
    seed([deindexed('a')]);
    const before = readFileSync(join(dir, 'seo/alerts.json'), 'utf8');

    const { done } = await assess({ dryRun: true });

    expect(done).toHaveLength(1);
    expect(readFileSync(join(dir, 'seo/alerts.json'), 'utf8')).toBe(before);
  });

  it('turns a failing call into a warning and still assesses the next alert', async () => {
    seed([deindexed('a'), deindexed('b')]);
    complete.mockRejectedValueOnce(new Error('overloaded\nstack'));

    const { done, warnings } = await assess();

    expect(warnings).toEqual([`Assessment failed for deindexed:${url('a')}: overloaded`]);
    expect(done.map(d => d.alert_id)).toEqual([`deindexed:${url('b')}`]);
  });

  it('rethrows BudgetExceededError and keeps the assessments already saved', async () => {
    seed([deindexed('a'), deindexed('b')]);
    complete.mockResolvedValueOnce(answer).mockRejectedValueOnce(new BudgetExceededError('budget gone'));

    await expect(assess()).rejects.toThrow('budget gone');
    expect(saved().find(a => a.detail === url('a')).assessment).toBeDefined();
    expect(saved().find(a => a.detail === url('b')).assessment).toBeUndefined();
  });

  it('strips markup and URLs from the model output and caps the lengths', async () => {
    seed([deindexed('a')]);
    complete.mockResolvedValue({
      likely_causes: ['<b>Thin</b> pages, see https://evil.example/x now', 'two', 'three', 'four'],
      actions: [{ action: `<script>x</script>Fix ${'y'.repeat(300)}`, why: 'Read www.evil.example today' }, ...['b', 'c', 'd', 'e', 'f'].map(x => ({ action: x, why: x }))],
    });

    const { done } = await assess();

    expect(done[0].likely_causes).toEqual(['Thin pages, see now', 'two', 'three']);
    expect(done[0].actions[0].action).toHaveLength(300);
    expect(done[0].actions[0].action).not.toContain('<');
    expect(done[0].actions[0].why).toBe('Read today');
    expect(done[0].actions.map(a => a.action).slice(1)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('puts the fetched page text only inside the untrusted block', async () => {
    seed([deindexed('a')]);
    await assess();
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toMatch(/<<<UNTRUSTED_PAGE_START>>>\s+Some page text\s+<<<UNTRUSTED_PAGE_END>>>/);
  });

  it('puts changes merged within 56 days into the prompt and leaves older ones out', async () => {
    seed([deindexed('a')]);
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/changes.json'), JSON.stringify({ version: 1, entries: [
      { kind: 'new', slug: 'recent-page', urls: [], merged_at: '2026-09-28' },
      { kind: 'rewrite', slug: 'old-page', urls: [], merged_at: '2026-08-09' },
    ] }));

    crawledAfterChanges();
    await assess();

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('- 2026-09-28: new page recent-page');
    expect(prompt).not.toContain('old-page');
  });

  it('marks a change that performs worse as a revert candidate', async () => {
    seed([deindexed('a')]);
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/changes.json'), JSON.stringify({ version: 1, entries: [
      { kind: 'rewrite', slug: 'bad-page', urls: [], merged_at: '2026-09-28', revert_candidate: true },
      { kind: 'new', slug: 'fine-page', urls: [], merged_at: '2026-09-27' },
    ] }));

    crawledAfterChanges();
    await assess();

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('- 2026-09-28: rewrite bad-page (performs worse than before, may need reverting)');
    expect(prompt).toContain('- 2026-09-27: new page fine-page\n');
  });

  it('warns and says the history is unknown when changes.json is unreadable', async () => {
    seed([deindexed('a')]);
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo/changes.json'), '{');

    const { warnings } = await assess();

    expect(warnings).toContain('Assessment: changes.json unreadable');
    expect(complete.mock.calls[0][0].prompt).toContain('unknown (change history unreadable)');
  });

  it('says none when there is no changes.json', async () => {
    seed([deindexed('a')]);

    await assess();

    expect(complete.mock.calls[0][0].prompt).toContain('## Recent changes\n\nnone\n');
  });

  describe('crawl gate', () => {
    const writeChange = (merged_at, urls = [url('a')]) => {
      mkdirSync(join(dir, 'seo'), { recursive: true });
      writeFileSync(join(dir, 'seo/changes.json'), JSON.stringify({ version: 1, entries: [{ kind: 'rewrite', slug: 'x', urls, merged_at }] }));
    };
    const writeCrawl = (lastCrawlTime) => {
      mkdirSync(join(dir, 'seo'), { recursive: true });
      writeFileSync(join(dir, 'seo/index-status.json'), JSON.stringify({ version: 1, updated: TODAY, entries: [{ url: url('a'), coverageState: 'Crawled - currently not indexed', lastCrawlTime }] }));
    };

    it('waits while no crawl followed the newest change and reports the alert', async () => {
      seed([deindexed('a')]);
      writeChange('2026-10-05');
      writeCrawl('2026-10-05T22:43:52Z');
      const waiting = [];

      const { done } = await assess({ waiting });

      expect(done).toEqual([]);
      expect(complete).not.toHaveBeenCalled();
      expect(waiting).toEqual([{ alert_id: `deindexed:${url('a')}`, last_change: '2026-10-05' }]);
    });

    it('assesses once a crawl came after the change', async () => {
      seed([deindexed('a')]);
      writeChange('2026-10-05');
      writeCrawl('2026-10-06T01:00:00Z');
      const waiting = [];

      const { done } = await assess({ waiting });

      expect(done).toHaveLength(1);
      expect(waiting).toEqual([]);
    });

    it('opens the gate early when the live check shows a crawl after the change, without writing index-status.json', async () => {
      seed([deindexed('a')]);
      writeChange('2026-10-05');
      writeCrawl('2026-10-04T00:00:00Z');
      const before = readFileSync(join(dir, 'seo/index-status.json'), 'utf8');
      const inspect = vi.fn(async urls => urls.map(u => ({ url: u, coverageState: 'x', lastCrawlTime: '2026-10-07T00:00:00Z' })));
      const waiting = [];

      const { done } = await assess({ waiting, inspect });

      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledWith([url('a')]);
      expect(done).toHaveLength(1);
      expect(waiting).toEqual([]);
      expect(readFileSync(join(dir, 'seo/index-status.json'), 'utf8')).toBe(before);
    });

    it('keeps waiting and warns when the live check throws', async () => {
      seed([deindexed('a')]);
      writeChange('2026-10-05');
      writeCrawl('2026-10-04T00:00:00Z');
      const waiting = [];

      const { done, warnings } = await assess({ waiting, inspect: async () => { throw new Error('quota'); } });

      expect(done).toEqual([]);
      expect(waiting).toHaveLength(1);
      expect(warnings).toEqual([`Assessment: live crawl check failed for deindexed:${url('a')}`]);
    });

    it('takes the last change per alert: a merge for another URL neither waits nor makes it stale', async () => {
      seed([deindexed('a', { assessment: { assessed_at: '2026-09-30', likely_causes: [], actions: [] } })]);
      writeChange('2026-10-05', [url('other') + '/']);
      const waiting = [];

      const { done } = await assess({ waiting });

      expect(done).toEqual([]);
      expect(waiting).toEqual([]);
      expect(complete).not.toHaveBeenCalled();
    });

    it('stops waiting after 28 days even without a recrawl', async () => {
      seed([deindexed('a')]);
      writeChange('2026-09-08');
      writeCrawl('2026-09-01T00:00:00Z');

      const { done } = await assess();

      expect(done).toHaveLength(1);
    });

    it('reassesses an assessment that predates the change once a crawl followed', async () => {
      seed([deindexed('a', { assessment: { assessed_at: '2026-09-30', likely_causes: [], actions: [] } })]);
      writeChange('2026-10-02');
      writeCrawl('2026-10-04T00:00:00Z');

      const { done } = await assess();

      expect(done).toHaveLength(1);
    });
  });

  describe('prompt data', () => {
    it('keeps real commits beyond a run of seo state commits and fences links and commits', async () => {
      seed([deindexed('a')]);
      const lines = [...Array.from({ length: 40 }, (_, i) => `2026-10-0${i % 9 + 1} seo: state ${i}`), '2026-09-30 fix: noindex', '2026-09-29 feat: menu', '2026-09-28 chore: robots'];

      await assess({ gitLog: () => lines.join('\n') });

      const prompt = complete.mock.calls[0][0].prompt;
      expect(prompt).toMatch(/<<<UNTRUSTED_COMMITS_START>>>\n- 2026-09-30 fix: noindex\n- 2026-09-29 feat: menu\n- 2026-09-28 chore: robots\n<<<UNTRUSTED_COMMITS_END>>>/);
      expect(prompt).not.toContain('seo: state');
      expect(prompt).toMatch(/<<<UNTRUSTED_LINKS_START>>>[\s\S]*<<<UNTRUSTED_LINKS_END>>>/);
    });

    it('warns once and notes it in the prompt when the home page cannot be fetched', async () => {
      seed([deindexed('a'), deindexed('b')]);
      const fetch = async (u) => { if (u === 'https://a.de') throw new Error('down'); return page(); };

      const { warnings } = await assess({ fetch });

      expect(warnings.filter(w => w === 'Assessment: home page links unavailable')).toHaveLength(1);
      expect(complete.mock.calls[0][0].prompt).toContain('(home page links unavailable)');
    });
  });

  describe('internalLinks', () => {
    it('keeps same-host paths, strips query and hash, skips assets and dedupes', () => {
      const html = `<a href="/b?x=1#top">b</a><a href='/a'>a</a><a href="https://a.de/b">b</a><a href="https://other.de/c">c</a><a href="/logo.png">i</a><a href="/doc.pdf">d</a><a href="/old.html">o</a><a href="rel">r</a><a>no</a>`;
      expect(internalLinks(html, 'https://a.de/dir/page')).toEqual(['/a', '/b', '/dir/rel', '/old.html']);
    });
  });
});
