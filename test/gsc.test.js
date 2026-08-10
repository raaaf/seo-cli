import { describe, it, expect } from 'vitest';
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
