// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { auditRows, modernRequest, rawPost, startApi, startDatabase, type RunningApi } from './helpers.js';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  api = await startApi(databaseUrl, { issuer });
});

afterAll(async () => {
  await api.close();
  await issuer.close();
  await postgres.stop();
});

function listRequest(token?: string): Promise<Response> {
  const { body, headers } = modernRequest('tools/list');
  return rawPost(api.url, body, { ...headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) });
}

describe('AUTH-2 protected resource metadata', () => {
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])('serves the document at %s', async (path) => {
    const response = await fetch(`${api.url}${path}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: api.resource,
      authorization_servers: [issuer.issuer],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
      resource_name: 'Mandate',
    });
  });

  it('answers 404 for another suffixed path', async () => {
    expect((await fetch(`${api.url}/.well-known/oauth-protected-resource/other`)).status).toBe(404);
  });

  it('answers an unauthenticated MCP request with 401 and resource_metadata, and audits nothing', async () => {
    const before = (await auditRows(databaseUrl)).length;
    const response = await listRequest();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${new URL(api.resource).origin}/.well-known/oauth-protected-resource/mcp"`);
    expect((await auditRows(databaseUrl)).length).toBe(before);
  });
});

describe('AUTH-1 invalid tokens are refused before the MCP server', () => {
  it('refuses an expired token with 401 and records auth.rejected with the reason only', async () => {
    const token = await issuer.token({ sub: 'alice-id', groups: ['content'], aud: api.resource, expiresIn: -5 });
    const response = await listRequest(token);
    expect(response.status).toBe(401);
    const correlationId = response.headers.get('x-correlation-id');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.rejected', actor: 'unknown', outcome: 'denied', details: { reason: 'expired' } })]);
    expect(JSON.stringify(rows)).not.toContain(token.split('.')[1]);
  });

  it('refuses a token issued for another resource', async () => {
    const response = await listRequest(await issuer.token({ sub: 'alice-id', aud: 'http://127.0.0.1:1/other-mcp' }));
    expect(response.status).toBe(401);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows[0]?.details).toEqual({ reason: 'invalid_audience' });
  });

  it('accepts a valid token', async () => {
    expect((await listRequest(await issuer.token({ sub: 'alice-id', groups: ['content'], aud: api.resource }))).status).toBe(200);
  });
});
