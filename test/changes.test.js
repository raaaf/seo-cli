import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const getPR = vi.fn();
vi.mock('../src/lib/github.js', async (orig) => ({
  ...(await orig()), getPR: (...a) => getPR(...a), deleteBranch: vi.fn(),
}));

const { reconcileState } = await import('../src/commands/run.js');
const { loadChanges, saveChanges, upsertEntry } = await import('../src/lib/changes.js');
const { loadKeywords, saveKeywords } = await import('../src/lib/keywords.js');
const { loadImprovements, saveImprovements } = await import('../src/lib/improvements.js');
const { format } = await import('../src/lib/date.js');

const CONFIG = {
  repo: 'o/r', base_url: 'https://a.de/', locales: ['de'], landing_path: 'content/de/',
  counterpart_locale: 'en', counterpart_url_prefix: '/en',
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const KW_PR = 'https://github.com/o/r/pull/1';
const IMP_PR = 'https://github.com/o/r/pull/2';

let dir, warnings;
const reconcile = () => reconcileState({ config: CONFIG, cwd: dir, warnings });
const merged = (mergedAt, createdAt = daysAgo(40)) => ({ state: 'merged', mergedAt, createdAt, headRef: 'x' });

function seedKeyword(extra = {}) {
  saveKeywords({ keywords: [{
    keyword: 'webdesign', status: 'pr_opened', target_slug: 'webdesign', pr_url: KW_PR,
    pr_opened_at: format(new Date(Date.now() - 40 * 86400000)), sitemap_slugs: ['/webdesign', '/en/web-design'], ...extra,
  }] }, dir);
}
function seedImprovement(extra = {}) {
  saveImprovements({ entries: [{ slug: 'preise', date: format(new Date(Date.now() - 40 * 86400000)), queries: [], pr_url: IMP_PR, ...extra }] }, dir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-changes-'));
  warnings = [];
  getPR.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('changes: ledger file', () => {
  it('never overwrites an existing entry and its readings', () => {
    const data = { entries: [{ id: 'a', readings: { d28: { clicks: 1 } } }] };
    expect(upsertEntry(data, { id: 'a', readings: { d28: null } })).toBe(false);
    expect(upsertEntry(data, { id: 'b' })).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].readings.d28).toEqual({ clicks: 1 });
  });

  it('throws on a corrupt file instead of reading it as empty', () => {
    mkdirSync(join(dir, 'seo'));
    writeFileSync(join(dir, 'seo/changes.json'), '{nope');
    expect(() => loadChanges(dir)).toThrow(/changes.json/);
  });
});

describe('sitemap resubmit after a hand merge', () => {
  const submit = vi.fn();
  const resubmit = (extra = {}) => reconcileState({ config: CONFIG, cwd: dir, warnings, submit, ...extra });
  beforeEach(() => submit.mockReset());

  it('submits once for the held drafts merged in this run, and for no auto-merged PR', async () => {
    saveImprovements({ entries: [
      { slug: 'preise', date: '2026-10-01', queries: [], pr_url: IMP_PR, held: true },
      { slug: 'kontakt', date: '2026-10-01', queries: [], pr_url: 'https://github.com/o/r/pull/3', held: true },
      { slug: 'team', date: '2026-10-01', queries: [], pr_url: 'https://github.com/o/r/pull/4' },
    ] }, dir);
    getPR.mockResolvedValue(merged('2026-10-05T08:00:00Z'));

    await resubmit();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].urls).toEqual(['https://a.de/preise', 'https://a.de/kontakt']);
  });

  it('does not submit for an auto-merged PR', async () => {
    seedImprovement();
    getPR.mockResolvedValue(merged('2026-10-05T08:00:00Z'));
    await resubmit();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not submit for a held draft that is still open or was merged in an earlier run', async () => {
    saveImprovements({ entries: [
      { slug: 'preise', date: '2026-10-01', queries: [], pr_url: IMP_PR, held: true },
      { slug: 'old', date: '2026-09-01', queries: [], pr_url: 'https://github.com/o/r/pull/5', held: true, merged_at: '2026-09-03' },
    ] }, dir);
    getPR.mockResolvedValue({ state: 'open', mergedAt: null, createdAt: daysAgo(10), headRef: 'x' });
    await resubmit();
    expect(submit).not.toHaveBeenCalled();
  });

  it('turns a failing submit into a warning', async () => {
    saveImprovements({ entries: [{ slug: 'preise', date: '2026-10-01', queries: [], pr_url: IMP_PR, held: true }] }, dir);
    getPR.mockResolvedValue(merged('2026-10-05T08:00:00Z'));
    const failing = async () => { throw new Error('GSC 500'); };
    await resubmit({ submit: failing });
    expect(warnings).toContain('Sitemap resubmit after a hand merge failed: GSC 500');
  });

  it('with watch.check_deploy only submits pages that are live', async () => {
    saveImprovements({ entries: [
      { slug: 'preise', date: '2026-10-01', queries: [], pr_url: IMP_PR, held: true },
      { slug: 'kontakt', date: '2026-10-01', queries: [], pr_url: 'https://github.com/o/r/pull/3', held: true },
    ] }, dir);
    getPR.mockResolvedValue(merged('2026-10-05T08:00:00Z'));
    const fetchPage = async (url) => ({ status: url.endsWith('/kontakt') ? 404 : 200 });

    await resubmit({ config: { ...CONFIG, watch: { check_deploy: true } }, fetchPage });

    expect(submit.mock.calls[0][0].urls).toEqual(['https://a.de/preise']);
    expect(warnings.join('\n')).toMatch(/skipped for 1 page\(s\)/);
  });
});

describe('changes: reconcileState writes the ledger', () => {
  it('adds an entry for a merged keyword PR, urls from sitemap_slugs, and stores published_at', async () => {
    seedKeyword();
    getPR.mockResolvedValue(merged('2026-09-02T10:00:00Z'));

    await reconcile();

    expect(loadChanges(dir).entries).toEqual([{
      id: KW_PR, kind: 'new', slug: 'webdesign', urls: ['https://a.de/webdesign', 'https://a.de/en/web-design'],
      pr_url: KW_PR, merged_at: '2026-09-02', baseline: null, readings: { d28: null, d56: null }, revert_candidate: false,
    }]);
    expect(loadKeywords(dir).keywords[0]).toMatchObject({ status: 'published', published_at: '2026-09-02' });
  });

  it('adds an entry for a merged rewrite with the counterpart named by alternate', async () => {
    seedImprovement();
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    writeFileSync(join(dir, 'content/de/preise.md'), '---\nslug: preise\nalternate: pricing\n---\nbody');
    getPR.mockResolvedValue(merged('2026-09-05T08:00:00Z'));

    await reconcile();

    const [entry] = loadChanges(dir).entries;
    expect(entry).toMatchObject({ kind: 'rewrite', slug: 'preise', merged_at: '2026-09-05', urls: ['https://a.de/preise', 'https://a.de/en/pricing'] });
    expect(loadImprovements(dir).entries[0].merged_at).toBe('2026-09-05T08:00:00Z');
  });

  it('writes no entry without a real mergedAt, the cooldown date still falls back', async () => {
    seedKeyword();
    seedImprovement();
    getPR.mockResolvedValue({ state: 'merged', mergedAt: null, createdAt: daysAgo(40), headRef: 'x' });

    await reconcile();

    expect(loadChanges(dir).entries).toEqual([]);
    expect(loadImprovements(dir).entries[0].merged_at).toBe(format(new Date()));
  });

  it('adds nothing twice and keeps existing readings on the second run', async () => {
    seedKeyword();
    getPR.mockResolvedValue(merged('2026-09-02T10:00:00Z'));
    await reconcile();
    const book = loadChanges(dir);
    book.entries[0].readings.d28 = { clicks: 7 };
    saveChanges(book, dir);

    await reconcile();

    const entries = loadChanges(dir).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].readings.d28).toEqual({ clicks: 7 });
  });
});

describe('changes: backfill of merged PRs without an entry', () => {
  it('picks up a published keyword and an older rewrite, and keeps the real merge date', async () => {
    seedKeyword({ status: 'published' });
    seedImprovement({ merged_at: format(new Date()) });
    getPR.mockImplementation(async ({ url }) => merged(url === KW_PR ? '2026-09-02T10:00:00Z' : '2026-09-05T08:00:00Z'));

    await reconcile();

    const entries = loadChanges(dir).entries;
    expect(entries.map(e => [e.kind, e.merged_at])).toEqual([['new', '2026-09-02'], ['rewrite', '2026-09-05']]);
    expect(loadKeywords(dir).keywords[0].published_at).toBe('2026-09-02');
  });

  it('records a PR merged more than 90 days ago as skipped and does not read it again', async () => {
    const old = format(new Date(Date.now() - 120 * 86400000));
    seedKeyword({ status: 'published', pr_opened_at: old });
    seedImprovement({ merged_at: old, date: old });
    getPR.mockImplementation(async () => merged(daysAgo(100)));

    await reconcile();

    expect(loadChanges(dir).entries).toEqual([]);
    expect(loadChanges(dir).skipped).toEqual([{ id: KW_PR, reason: 'too_old' }, { id: IMP_PR, reason: 'too_old' }]);

    getPR.mockClear();
    await reconcile();
    expect(getPR).not.toHaveBeenCalled();
  });

  it('records a merged PR without a real merge date as skipped and does not read it again', async () => {
    seedKeyword({ status: 'published' });
    getPR.mockResolvedValue({ state: 'merged', mergedAt: null, createdAt: daysAgo(40), headRef: 'x' });

    await reconcile();
    expect(loadChanges(dir).skipped).toEqual([{ id: KW_PR, reason: 'no_merge_date' }]);

    getPR.mockClear();
    await reconcile();
    expect(getPR).not.toHaveBeenCalled();
  });

  it('measures the 90 days from the merge date, not from the creation of the PR', async () => {
    const old = format(new Date(Date.now() - 120 * 86400000));
    seedKeyword({ status: 'published', pr_opened_at: old });
    getPR.mockResolvedValue(merged(daysAgo(30), daysAgo(120)));

    await reconcile();

    expect(loadChanges(dir).entries).toHaveLength(1);
  });

  it('keeps an existing published_at', async () => {
    seedKeyword({ status: 'published', published_at: '2026-08-30' });
    getPR.mockResolvedValue(merged('2026-09-02T10:00:00Z'));

    await reconcile();

    expect(loadKeywords(dir).keywords[0].published_at).toBe('2026-08-30');
    expect(loadChanges(dir).entries[0].merged_at).toBe('2026-09-02');
  });

  it('adds the counterpart URL to a rewrite entry once the alternate is readable, without asking GitHub', async () => {
    seedImprovement({ merged_at: '2026-09-05T08:00:00Z' });
    mkdirSync(join(dir, 'content/de'), { recursive: true });
    getPR.mockResolvedValue(merged('2026-09-05T08:00:00Z'));
    await reconcile();
    expect(loadChanges(dir).entries[0].urls).toEqual(['https://a.de/preise']);

    writeFileSync(join(dir, 'content/de/preise.md'), '---\nslug: preise\nalternate: pricing\n---\nbody');
    getPR.mockClear();
    await reconcile();

    expect(getPR).not.toHaveBeenCalled();
    expect(loadChanges(dir).entries[0].urls).toEqual(['https://a.de/preise', 'https://a.de/en/pricing']);
  });

  it('retries a PR that cannot be read on the next run', async () => {
    seedKeyword({ status: 'published' });
    getPR.mockRejectedValueOnce(new Error('boom'));

    await reconcile();
    expect(loadChanges(dir).entries).toEqual([]);
    expect(warnings[0]).toMatch(/Could not read/);

    getPR.mockResolvedValue(merged('2026-09-02T10:00:00Z'));
    await reconcile();
    expect(loadChanges(dir).entries).toHaveLength(1);
  });
});
