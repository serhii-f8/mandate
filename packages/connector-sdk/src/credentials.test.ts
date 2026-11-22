// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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

describe('CONN-3 oauth_password secret', () => {
  it('CONN-3 lists the four field names', () => {
    expect(secretFieldNames('oauth_password')).toEqual(['client_id', 'client_secret', 'username', 'password']);
  });
  it('CONN-3 SEC-3 a missing password fails naming the field and quoting no value', () => {
    const r = parseSecret('oauth_password', { client_id: 'c', client_secret: 'sentinel-secret', username: 'sentinel-user' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('password');
      expect(r.message).not.toContain('sentinel-secret');
      expect(r.message).not.toContain('sentinel-user');
    }
  });
});

describe('CONN-3 oauth1 secret', () => {
  it('CONN-3 lists the four field names', () => {
    expect(secretFieldNames('oauth1')).toEqual(['consumer_key', 'consumer_secret', 'token', 'token_secret']);
  });
  it('CONN-3 SEC-3 a missing token secret fails naming the field and quoting no value', () => {
    const r = parseSecret('oauth1', { consumer_key: 'sentinel-ck', consumer_secret: 'sentinel-cs', token: 'sentinel-tk' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('token_secret');
      expect(r.message).not.toContain('sentinel');
    }
  });
});

describe('SEC-2 webhook_url secret', () => {
  it('SEC-2 accepts an https webhook URL', () => {
    const r = parseSecret('webhook_url', { url: 'https://hooks.slack.com/services/T/B/x' });
    expect(r).toEqual({ ok: true, secret: { url: 'https://hooks.slack.com/services/T/B/x' } });
    expect(parseSecret('webhook_url', { url: 'http://chat.example.test/hook' }).ok).toBe(true);
  });
  it('SEC-2 rejects a non-http URL and a non-URL, naming the field only', () => {
    for (const url of ['ftp://x', 'not a url']) {
      const r = parseSecret('webhook_url', { url });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe('invalid secret for scheme webhook_url: check url');
        expect(r.message).not.toContain('ftp');
      }
    }
  });
  it('SEC-2 rejects another scheme\'s field without quoting input or key names', () => {
    const r = parseSecret('webhook_url', { token: 'https://hooks.slack.com/services/T/B/x' });
    expect(r.ok).toBe(false);
    // The unknown key is reported as `(value)`: key names are input too (SEC-3).
    if (!r.ok) {
      expect(r.message).toBe('invalid secret for scheme webhook_url: check url, (value)');
      expect(r.message).not.toContain('hooks.slack.com');
    }
  });
  it('SEC-2 limits the URL to 2048 characters', () => {
    const base = 'https://hooks.slack.com/';
    expect(parseSecret('webhook_url', { url: base + 'a'.repeat(2048 - base.length) }).ok).toBe(true);
    expect(parseSecret('webhook_url', { url: base + 'a'.repeat(2049 - base.length) }).ok).toBe(false);
  });
  it('SEC-2 lists url as the only field', () => {
    expect(secretFieldNames('webhook_url')).toEqual(['url']);
  });
});
