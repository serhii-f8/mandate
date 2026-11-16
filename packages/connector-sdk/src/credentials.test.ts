import { describe, expect, it } from 'vitest';
import { parseSecret, secretFieldNames } from './credentials.js';

describe('SEC-2 secret material per scheme', () => {
  it('accepts a bearer token', () => {
    const r = parseSecret('bearer', { token: 'x' });
    expect(r).toEqual({ ok: true, secret: { token: 'x' } });
  });
  it('rejects unknown keys', () => {
    expect(parseSecret('bearer', { token: 'x', extra: 1 }).ok).toBe(false);
  });
  it('rejects empty and over-long strings', () => {
    expect(parseSecret('bearer', { token: '' }).ok).toBe(false);
    expect(parseSecret('bearer', { token: 'a'.repeat(8193) }).ok).toBe(false);
    expect(parseSecret('bearer', { token: 'a'.repeat(8192) }).ok).toBe(true);
  });
  it('fails a partial basic secret without quoting input', () => {
    const r = parseSecret('basic', { username: 'sentinel-user-value' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('sentinel-user-value');
  });
  it('rejects non-objects', () => {
    expect(parseSecret('api_key', 'nope').ok).toBe(false);
  });
  it('lists the field names per scheme', () => {
    expect(secretFieldNames('oauth_client_credentials')).toEqual(['client_id', 'client_secret']);
    expect(secretFieldNames('api_key')).toEqual(['key']);
  });
});
