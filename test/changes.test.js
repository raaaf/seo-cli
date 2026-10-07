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

  it('ignores PRs opened more than 90 days ago without asking GitHub', async () => {
    const old = format(new Date(Date.now() - 120 * 86400000));
    seedKeyword({ status: 'published', pr_opened_at: old });
    seedImprovement({ merged_at: old, date: old });

    await reconcile();

    expect(getPR).not.toHaveBeenCalled();
    expect(loadChanges(dir).entries).toEqual([]);
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
