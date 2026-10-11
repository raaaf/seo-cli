import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/safe-fetch.js', () => ({ assertPublicUrl: vi.fn(async () => {}) }));

const rybbit = await import('../src/lib/rybbit.js');

const KEY = 'secret-key-123';
const config = { rybbit: { enabled: true, url: 'https://tracking.example.org', site_id: 3 } };
const WINDOW = { startDate: '2026-10-05', endDate: '2026-10-11' };
const res = (status, body = {}) => ({ status, ok: status < 300, json: async () => body });
const fails = (p) => p.then(() => null, e => e);
const row = (value, count) => ({ value, hostname: 'x', count, percentage: 1, pageviews: count, time_on_page_seconds: 40.3, bounce_rate: 73.9 });

let fetchMock;
beforeEach(() => {
  process.env.RYBBIT_API_KEY = KEY;
  rybbit.resetRybbitGuard();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete process.env.RYBBIT_API_KEY;
  vi.unstubAllGlobals();
});

describe('rybbitRequest', () => {
  it.each([[401, 'key_rejected'], [403, 'key_rejected'], [429, 'rate_limited'], [503, 'unavailable'], [404, 'error']])(
    'maps HTTP %i to %s', async (status, kind) => {
      fetchMock.mockResolvedValue(res(status));
      const err = await fails(rybbit.rybbitRequest(config, 'metric'));
      expect(err).toBeInstanceOf(rybbit.RybbitError);
      expect(err).toMatchObject({ kind, status });
    });

  it('never puts the key or the URL into a message, also when fetch throws with them', async () => {
    fetchMock.mockRejectedValue(new Error(`boom https://tracking.example.org Bearer ${KEY}`));
    const err = await fails(rybbit.rybbitRequest(config, 'metric'));
    expect(err.kind).toBe('unavailable');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('tracking.example.org');
  });

  it('sends the key as Bearer header and never follows a redirect', async () => {
    fetchMock.mockResolvedValue(res(200, { data: [] }));
    await rybbit.rybbitRequest(config, 'goals');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(opts.redirect).toBe('manual');
    expect(url).not.toContain(KEY);
  });

  it.each([301, 302, 307, 308])('rejects a %i redirect as an error', async (status) => {
    fetchMock.mockResolvedValue(res(status));
    const err = await fails(rybbit.rybbitRequest(config, 'metric'));
    expect(err).toMatchObject({ kind: 'error', status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('talks https only, without calling fetch', async () => {
    const err = await fails(rybbit.rybbitRequest({ rybbit: { ...config.rybbit, url: 'http://tracking.example.org' } }, 'metric'));
    expect(err.kind).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops calling Rybbit after two failures in a row', async () => {
    fetchMock.mockResolvedValue(res(500));
    await fails(rybbit.rybbitRequest(config, 'a'));
    await fails(rybbit.rybbitRequest(config, 'b'));
    const err = await fails(rybbit.rybbitRequest(config, 'c'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ kind: 'unavailable', method: 'c' });
  });

  it('a success resets the failure count', async () => {
    fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200, {})).mockResolvedValue(res(500));
    await fails(rybbit.rybbitRequest(config, 'a'));
    await rybbit.rybbitRequest(config, 'b');
    await fails(rybbit.rybbitRequest(config, 'c'));
    await fails(rybbit.rybbitRequest(config, 'd'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a rejected key stops the very next call', async () => {
    fetchMock.mockResolvedValue(res(401));
    await fails(rybbit.rybbitRequest(config, 'a'));
    const err = await fails(rybbit.rybbitRequest(config, 'b'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe('key_rejected');
  });
});

describe('endpoints', () => {
  it('entryPages asks for the window and keeps only the used fields', async () => {
    fetchMock.mockResolvedValue(res(200, { data: { data: [row('/a', 23)], totalCount: 1 } }));
    const rows = await rybbit.entryPages(config, WINDOW);
    expect(rows).toEqual([{ value: '/a', count: 23, bounce_rate: 73.9, time_on_page_seconds: 40.3 }]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/sites/3/metric');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      parameter: 'entry_page', start_date: '2026-10-05', end_date: '2026-10-11', time_zone: 'Europe/Berlin',
    });
  });

  it('aiEntryPages filters the referrer on the AI hosts', async () => {
    fetchMock.mockResolvedValue(res(200, { data: { data: [] } }));
    await rybbit.aiEntryPages(config, WINDOW, 'referrer');
    const filters = JSON.parse(new URL(fetchMock.mock.calls[0][0]).searchParams.get('filters'));
    expect(filters).toEqual([{ parameter: 'referrer', type: 'equals', value: rybbit.AI_HOSTS }]);
  });

  it('goalsForEntry filters on the path variants, site-wide without paths', async () => {
    fetchMock.mockResolvedValue(res(200, { data: [{ goalId: 20, name: 'Signup', total_conversions: 1, total_sessions: 63, config: {} }] }));
    expect(await rybbit.goalsForEntry(config, WINDOW, ['/a', '/a/'])).toEqual([{ goalId: 20, name: 'Signup', total_conversions: 1, total_sessions: 63 }]);
    expect(JSON.parse(new URL(fetchMock.mock.calls[0][0]).searchParams.get('filters')))
      .toEqual([{ parameter: 'entry_page', type: 'equals', value: ['/a', '/a/'] }]);
    await rybbit.goalsForEntry(config, WINDOW);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.has('filters')).toBe(false);
  });

  it('a body of the wrong shape is an error', async () => {
    fetchMock.mockResolvedValue(res(200, { data: 'nope' }));
    expect((await fails(rybbit.entryPages(config, WINDOW))).kind).toBe('error');
  });
});
