import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describeAuthError, buildRequestBody } from '../src/lib/gsc.js';

describe('gsc-auth-error', () => {
  it('returns an actionable hint for an expired/invalid_grant token', () => {
    const hint = describeAuthError(new Error('invalid_grant: Token has been expired or revoked.'));
    expect(hint).toContain('.seo-cli-token.json');
    expect(hint).toMatch(/re-authorize|service account/);
  });

  it('detects the error nested in the googleapis response body', () => {
    expect(describeAuthError({ response: { data: { error: 'invalid_grant' } } })).toBeTruthy();
    expect(describeAuthError({ response: { data: { error_description: 'Token has been expired' } } })).toBeTruthy();
  });

  it('returns null for unrelated errors (403, network) so other handling stays intact', () => {
    expect(describeAuthError(Object.assign(new Error('Forbidden'), { code: 403 }))).toBe(null);
    expect(describeAuthError(new Error('ECONNRESET'))).toBe(null);
    expect(describeAuthError(null)).toBe(null);
  });
});

describe('buildRequestBody', () => {
  const base = { startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['page', 'query'], rowLimit: 500 };

  it('sends no filter group when no page filter is given', () => {
    expect(buildRequestBody({ ...base, pageFilter: null }).dimensionFilterGroups).toBeUndefined();
  });

  it('narrows to the project host so a domain property does not spend the row limit on siblings', () => {
    const body = buildRequestBody({ ...base, pageFilter: 'https://rafaelalex.de' });

    expect(body.dimensionFilterGroups).toEqual([
      { filters: [{ dimension: 'page', operator: 'contains', expression: 'https://rafaelalex.de' }] },
    ]);
    expect(body.rowLimit).toBe(500);
  });
});

describe('queryPagePerformance row limit', () => {
  // Regression: the query asked for 500 page/query rows while one project's real
  // result set was 764. The response came back silently truncated and every
  // aggregate built on it (improve's page score, the rankings CSV, the dashboard)
  // described a sample. Pages whose impressions spread over many long-tail
  // queries lost most of their rows and scored as tiny.
  const queryFn = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    queryFn.mockReset();
    queryFn.mockResolvedValue({ data: { rows: [] } });

    vi.doMock('googleapis', () => ({
      google: {
        auth: { JWT: class { constructor() {} } },
        searchconsole: () => ({ searchanalytics: { query: queryFn } }),
      },
    }));

    const credentials = join(tmpdir(), `gsc-cred-${Date.now()}.json`);
    writeFileSync(credentials, JSON.stringify({ type: 'service_account', client_email: 'a@b.c', private_key: 'k' }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
  });

  it('asks for the whole result set, not a truncating sample', async () => {
    const { queryPagePerformance } = await import('../src/lib/gsc.js');

    await queryPagePerformance('https://events.rafaelalex.de/');

    expect(queryFn.mock.calls[0][0].requestBody.rowLimit).toBe(25000);
  });

  it('warns when the response hits the ceiling, because truncation is invisible in the payload', async () => {
    const { queryPagePerformance } = await import('../src/lib/gsc.js');
    queryFn.mockResolvedValue({ data: { rows: new Array(25000).fill({ keys: ['u', 'q'], impressions: 1, clicks: 0, position: 1 }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await queryPagePerformance('https://events.rafaelalex.de/');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
    warn.mockRestore();
  });

  it('stays quiet for a result set that fits', async () => {
    const { queryPagePerformance } = await import('../src/lib/gsc.js');
    queryFn.mockResolvedValue({ data: { rows: new Array(769).fill({ keys: ['u', 'q'], impressions: 1, clicks: 0, position: 1 }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await queryPagePerformance('https://events.rafaelalex.de/');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
