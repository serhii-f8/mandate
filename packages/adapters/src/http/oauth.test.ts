// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { afterEach, describe, expect, it } from 'vitest';
import { clearTokenCache, clientCredentialsToken } from './oauth.js';

afterEach(() => {
  clearTokenCache();
});

describe('CONN-3 token cache', () => {
  it('CONN-3 a rejecting transport rejects the caller without an unhandled rejection', async () => {
    const p = { tokenUrl: 'http://idp.test/token', clientId: 'c', clientSecret: 's', scopes: [], timeoutMs: 100 };
    await expect(clientCredentialsToken('oauth-reject', p, { now: Date.now }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // Let any stray promise settle inside this test so an unhandled rejection is attributed here.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
