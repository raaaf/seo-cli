import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { fetchIndexStatus, diffIndexStatus, isIndexed } = await import('../src/lib/index-status.js');

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

  it('keeps the URLs already inspected and marks the rest unknown on a quota error', async () => {
    inspect.mockResolvedValueOnce(inspected('Submitted and indexed'));
    inspect.mockRejectedValueOnce(Object.assign(new Error('Quota exceeded'), { code: 429 }));

    const results = await fetchIndexStatus(CONFIG, ['https://s/a', 'https://s/b', 'https://s/c'], 0);

    expect(results).toEqual([
      { url: 'https://s/a', coverageState: 'Submitted and indexed', lastCrawlTime: null, verdict: 'FAIL', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED' },
      { url: 'https://s/b', coverageState: 'unknown', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null },
      { url: 'https://s/c', coverageState: 'unknown', lastCrawlTime: null, verdict: null, robotsTxtState: null, indexingState: null },
    ]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
