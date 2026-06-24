import { describe, it, expect } from 'vitest';
import { describeAuthError } from '../src/lib/gsc.js';

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
