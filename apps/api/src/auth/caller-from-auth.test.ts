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

describe('AUTH-7 the access token never leaves authentication', () => {
  it('builds the caller without the token, even if AuthInfo still carried one', () => {
    const caller = callerFromAuthInfo({ ...info({ sub: 'a', groups: ['content'] }), token: TOKEN });
    expect(JSON.stringify(caller)).not.toContain('secret-token-body');
  });
});
