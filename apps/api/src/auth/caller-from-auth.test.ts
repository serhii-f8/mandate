// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuthInfo } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { callerFromAuthInfo } from './caller-from-auth.js';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-token-body.signature';

function info(extra: Record<string, unknown>, clientId = 'aiops-mcp'): AuthInfo {
  return { token: '', clientId, scopes: [], extra };
}

describe('AUTH-3 groups claim', () => {
  it('takes subject, client and groups from the verified token', () => {
    expect(callerFromAuthInfo(info({ sub: 'alice-id', groups: ['content', 'leads'] }))).toEqual({
      subject: 'alice-id',
      clientId: 'aiops-mcp',
      groups: ['content', 'leads'],
    });
  });

  it.each([[undefined], ['content'], [{ content: true }]])('gives no groups for a claim of %j', (groups) => {
    expect(callerFromAuthInfo(info({ sub: 'a', groups })).groups).toEqual([]);
  });

  it('drops non-string, empty and over-long entries', () => {
    expect(callerFromAuthInfo(info({ sub: 'a', groups: ['ok', 7, '', 'x'.repeat(256), null] })).groups).toEqual(['ok']);
  });

  it('keeps at most 256 groups', () => {
    const groups = Array.from({ length: 300 }, (_, i) => `g${String(i)}`);
    expect(callerFromAuthInfo(info({ sub: 'a', groups })).groups).toHaveLength(256);
  });

  it('omits an empty client ID', () => {
    expect(Object.keys(callerFromAuthInfo(info({ sub: 'a' }, '')))).not.toContain('clientId');
  });

  it('refuses an AuthInfo without a subject', () => {
    expect(() => callerFromAuthInfo(info({}))).toThrow(/subject/);
  });
});

describe('AUTH-6 authentication time', () => {
  it('AUTH-6 auth_time becomes authTime; a non-number or out-of-range value is ignored', () => {
    expect(callerFromAuthInfo(info({ sub: 'a', auth_time: 1_794_909_570 })).authTime).toEqual(new Date(1_794_909_570_000));
    for (const auth_time of ['1794909570', null, Number.NaN, Number.POSITIVE_INFINITY, { t: 1 }, 1e300, -1, 8.64e12 + 1]) {
      expect(Object.keys(callerFromAuthInfo(info({ sub: 'a', auth_time }))), JSON.stringify(auth_time)).not.toContain('authTime');
    }
  });
});

describe('AUTH-7 the access token never leaves authentication', () => {
  it('builds the caller without the token, even if AuthInfo still carried one', () => {
    const caller = callerFromAuthInfo({ ...info({ sub: 'a', groups: ['content'] }), token: TOKEN });
    expect(JSON.stringify(caller)).not.toContain('secret-token-body');
  });
});

describe('AUTH-4 service caller', () => {
  it('AUTH-4 extra.service builds the service subject and ignores groups', () => {
    expect(callerFromAuthInfo(info({ sub: 'kc-id', groups: ['content'], service: 'aiops-sa-ci' }, 'aiops-sa-ci'))).toEqual({
      subject: 'service:aiops-sa-ci',
      clientId: 'aiops-sa-ci',
      groups: [],
    });
  });

  it('AUTH-6 AUTH-4 a service caller never carries authTime', () => {
    const caller = callerFromAuthInfo(info({ sub: 'kc-id', service: 'aiops-sa-ci', auth_time: 1_794_909_570 }, 'aiops-sa-ci'));
    expect(Object.keys(caller)).not.toContain('authTime');
  });

  it.each([[''], [7], [null]])('AUTH-4 a non-string or empty service %j is not a service caller', (service) => {
    expect(callerFromAuthInfo(info({ sub: 'kc-id', service })).subject).toBe('kc-id');
  });
});
