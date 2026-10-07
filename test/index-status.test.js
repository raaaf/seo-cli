import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// `diffIndexStatus`/`isIndexed` are pure and tested directly. `fetchIndexStatus`
// talks to the Search Console API, so googleapis and getAuth are mocked.

const inspect = vi.fn();
vi.mock('googleapis', () => ({
  google: { searchconsole: () => ({ urlInspection: { index: { inspect: (...a) => inspect(...a) } } }) },
}));
const getAuth = vi.fn().mockResolvedValue({});
vi.mock('../src/lib/gsc.js', () => ({
  getAuth: (...a) => getAuth(...a),
  rethrowWithAuthHint: (e) => { throw e; },
}));

const { fetchIndexStatus, diffIndexStatus, isIndexed, saveIndexStatus, loadIndexStatus } = await import('../src/lib/index-status.js');

const CONFIG = { gsc_property: 'https://zeit.rafaelalex.de/' };

function inspected(coverageState) {
  return { data: { inspectionResult: { indexStatusResult: { coverageState, verdict: 'FAIL', lastCrawlTime: null, robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED' } } } };
}

describe('index-status: isIndexed', () => {
  it('treats all three Google "not indexed" wordings as not indexed', () => {
    expect(isIndexed('Crawled - currently not indexed')).toBe(false);
    expect(isIndexed('Discovered - currently not indexed')).toBe(false);
    expect(isIndexed('URL is unknown to Google')).toBe(false);
  });

  it('treats a real indexed state as indexed', () => {
    expect(isIndexed('Submitted and indexed')).toBe(true);
  });
});

describe('index-status: diffIndexStatus', () => {
  it('classifies newly dropped, newly indexed and still missing', () => {
    const previous = {
      entries: [
        { url: 'a', coverageState: 'Submitted and indexed' },
        { url: 'b', coverageState: 'Crawled - currently not indexed' },
        { url: 'c', coverageState: 'Crawled - currently not indexed' },
        { url: 'd', coverageState: 'Submitted and indexed' },
      ],
    };
    const current = [
      { url: 'a', coverageState: 'Crawled - currently not indexed' }, // newly dropped
      { url: 'b', coverageState: 'Submitted and indexed' }, // newly indexed
      { url: 'c', coverageState: 'Discovered - currently not indexed' }, // still missing
      { url: 'd', coverageState: 'Submitted and indexed' }, // unchanged
    ];

    const diff = diffIndexStatus(previous, current);
    expect(diff.newlyDropped).toEqual(['a']);
    expect(diff.newlyIndexed).toEqual(['b']);
    expect(diff.stillMissing).toEqual(['c']);
    expect(diff.unchanged).toBe(1);
  });

  it('does not report a URL missing from a non-empty previous snapshot as newly dropped', () => {
    const previous = { entries: [{ url: 'a', coverageState: 'Submitted and indexed' }] };
    const current = [
      { url: 'a', coverageState: 'Submitted and indexed' },
      { url: 'new', coverageState: 'Crawled - currently not indexed' }, // first time inspected
    ];
    const diff = diffIndexStatus(previous, current);
    expect(diff.newlyDropped).toEqual([]);
    expect(diff.stillMissing).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });

  it('reports a first run with no previous snapshot as baseline, not as newly dropped', () => {
    const current = [
      { url: 'a', coverageState: 'Crawled - currently not indexed' },
      { url: 'b', coverageState: 'URL is unknown to Google' },
    ];
    const diff = diffIndexStatus({ entries: [] }, current);
    expect(diff.newlyDropped).toEqual([]);
    expect(diff.newlyIndexed).toEqual([]);
    expect(diff.stillMissing).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });
});

describe('index-status: fetchIndexStatus', () => {
  beforeEach(() => { inspect.mockReset(); getAuth.mockClear(); });

  it('inspects every URL and returns the fields the API returns', async () => {
    inspect.mockResolvedValueOnce(inspected('Submitted and indexed'));
    inspect.mockResolvedValueOnce(inspected('Crawled - currently not indexed'));

    const results = await fetchIndexStatus(CONFIG, ['https://s/a', 'https://s/b'], 0);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: 'https://s/a', coverageState: 'Submitted and indexed', verdict: 'FAIL' });
    expect(results[1]).toMatchObject({ url: 'https://s/b', coverageState: 'Crawled - currently not indexed' });
  });

  it('keeps the canonicals and the page fetch state the API returns', async () => {
    inspect.mockResolvedValueOnce({ data: { inspectionResult: { indexStatusResult: {
      coverageState: 'Crawled - currently not indexed', googleCanonical: 'https://s/other', userCanonical: 'https://s/a', pageFetchState: 'SOFT_404',
    } } } });

    const [result] = await fetchIndexStatus(CONFIG, ['https://s/a'], 0);

    expect(result).toMatchObject({ googleCanonical: 'https://s/other', userCanonical: 'https://s/a', pageFetchState: 'SOFT_404' });
  });

  it('keeps the URLs already inspected and marks the rest unknown on a quota error', async () => {
    inspect.mockResolvedValueOnce(inspected('Submitted and indexed'));
    inspect.mockRejectedValueOnce(Object.assign(new Error('Quota exceeded'), { code: 429 }));

    const results = await fetchIndexStatus(CONFIG, ['https://s/a', 'https://s/b', 'https://s/c'], 0);

    expect(results).toEqual([
      { url: 'https://s/a', coverageState: 'Submitted and indexed', lastCrawlTime: null, verdict: 'FAIL', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null, userCanonical: null, pageFetchState: null },
      { url: 'https://s/b', coverageState: 'unknown', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null, googleCanonical: null, userCanonical: null, pageFetchState: null },
      { url: 'https://s/c', coverageState: 'unknown', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null, googleCanonical: null, userCanonical: null, pageFetchState: null },
    ]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});

describe('index-status: saveIndexStatus', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-index-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = (url, coverageState) => ({ url, coverageState, lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null });

  const seed = (entries) => {
    mkdirSync(join(dir, 'seo'));
    writeFileSync(join(dir, 'seo/index-status.json'), JSON.stringify({ version: 1, updated: '2020-01-01', entries }, null, 2) + '\n');
  };

  it('keeps `updated` and the file bytes when the entries are the same', () => {
    seed([entry('a', 'Submitted and indexed')]);
    const path = join(dir, 'seo/index-status.json');
    const before = readFileSync(path, 'utf8');

    saveIndexStatus({ version: 1, updated: null, entries: [entry('a', 'Submitted and indexed')] }, dir);

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('keeps the file bytes on a recrawl that changes only lastCrawlTime, and stores it once the verdict changes', () => {
    seed([entry('a', 'Submitted and indexed')]);
    const path = join(dir, 'seo/index-status.json');
    const before = readFileSync(path, 'utf8');

    saveIndexStatus({ version: 1, updated: null, entries: [{ ...entry('a', 'Submitted and indexed'), lastCrawlTime: '2026-10-07T01:00:00Z' }] }, dir);
    expect(readFileSync(path, 'utf8')).toBe(before);

    saveIndexStatus({ version: 1, updated: null, entries: [{ ...entry('a', 'Crawled - currently not indexed'), lastCrawlTime: '2026-10-08T01:00:00Z' }] }, dir);
    expect(loadIndexStatus(dir).entries[0].lastCrawlTime).toBe('2026-10-08T01:00:00Z');
  });

  it('moves `updated` when an entry changes', () => {
    seed([entry('a', 'Submitted and indexed')]);

    saveIndexStatus({ version: 1, updated: null, entries: [entry('a', 'Crawled - currently not indexed')] }, dir);

    expect(loadIndexStatus(dir).updated).not.toBe('2020-01-01');
  });

  it('never lets an unknown entry overwrite the previous one', () => {
    saveIndexStatus({ version: 1, updated: null, entries: [entry('a', 'Submitted and indexed')] }, dir);
    saveIndexStatus({ version: 1, updated: null, entries: [entry('a', 'unknown'), entry('b', 'unknown')] }, dir);

    expect(loadIndexStatus(dir).entries.map(e => [e.url, e.coverageState])).toEqual([['a', 'Submitted and indexed'], ['b', 'unknown']]);
  });
});
