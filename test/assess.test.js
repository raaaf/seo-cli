import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { assessAlerts } = await import('../src/steps/assess.js');
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
const assess = (extra = {}) => { const warnings = []; return assessAlerts({ config: CONFIG, cwd: dir, today: TODAY, fetch: page, warnings, ...extra }).then(done => ({ done, warnings })); };

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
    expect(done[0].actions[0].action).toHaveLength(200);
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

    await assess();

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('- 2026-09-28: new page recent-page');
    expect(prompt).not.toContain('old-page');
  });

  it('says none when there is no changes.json', async () => {
    seed([deindexed('a')]);

    await assess();

    expect(complete.mock.calls[0][0].prompt).toContain('## Recent changes\n\nnone\n');
  });
});
