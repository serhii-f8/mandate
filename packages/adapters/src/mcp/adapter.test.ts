// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { LookupFunction } from 'node:net';
import type { ConnectionSettings, CredentialSource } from '@mandate/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createMcpToolAdapter } from './adapter.js';

let seq = 0;

/** An mcp connection with oauth1, which the loader refuses; the adapter must refuse it too (CONN-3). */
function oauth1Connection(): ConnectionSettings {
  seq += 1;
  return {
    id: `mcp-oauth1-${seq}`,
    kind: 'mcp',
    baseUrl: 'https://mcp.example.test/mcp',
    timeoutMs: 1000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 1,
    allowPrivateNetwork: false,
    extraHosts: [],
    auth: { scheme: 'oauth1', signatureMethod: 'HMAC-SHA256' },
  };
}

/** Counts every step that would lead to a request: opening the credential and resolving the host. */
function probes() {
  const seen = { opened: 0, lookups: 0, beforeSend: 0 };
  const credential: CredentialSource = {
    ref: 'mcp-cred',
    scheme: 'oauth1',
    open: () => {
      seen.opened += 1;
      return Promise.resolve({ consumer_key: 'ck', consumer_secret: 'cs', token: 'tk', token_secret: 'ts' });
    },
  };
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    seen.lookups += 1;
    callback(new Error('no lookup expected'), '', 4);
  };
  const beforeSend = (): Promise<void> => {
    seen.beforeSend += 1;
    return Promise.resolve();
  };
  return { seen, credential, lookup, beforeSend };
}

describe('CONN-3 the MCP adapter refuses oauth1 before sending', () => {
  it('CONN-3 list, call and call-once answer credential_unusable without opening the credential or resolving the host', async () => {
    const { seen, credential, lookup, beforeSend } = probes();
    const adapter = createMcpToolAdapter({ lookup, sleep: () => Promise.resolve() });
    expect(await adapter.listTools({ connection: oauth1Connection(), credential })).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(await adapter.callTool({ connection: oauth1Connection(), tool: 'search', args: {}, credential, retryable: true })).toMatchObject({
      ok: false,
      code: 'credential_unusable',
    });
    expect(await adapter.callOnce({ connection: oauth1Connection(), target: { kind: 'mcp', tool: 'cancel' }, args: {}, credential, beforeSend })).toMatchObject({
      result: 'not_sent',
      code: 'credential_unusable',
    });
    expect(seen).toEqual({ opened: 0, lookups: 0, beforeSend: 0 });
  });
});
