// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { AUDIT_CHAIN_FORMAT, auditRowHash, checkLink, GENESIS_HASH, type ChainRow, type SealedChainRow } from './chain.js';

const H1 = 'sha256:4aab69f9e45ece22e5139da9bc15b0aca186a69a79be028424afa63d0fb32a2e';
const H2 = 'sha256:4e9d6431583c0dc5a77a1451499063aed576b74dd87aff5713599a2f77a23ec2';

const row1: ChainRow = {
  pos: 1,
  id: '00000000-0000-4000-8000-000000000001',
  ts: '2026-11-18T10:00:00.123456Z',
  actor: 'alice-id',
  clientId: null,
  action: 'tool.call',
  subject: 'ping',
  decision: null,
  outcome: 'ok',
  correlationId: 'corr-1',
  changesetId: null,
  details: { durationMs: 2 },
};

const row2: ChainRow = {
  pos: 2,
  id: '00000000-0000-4000-8000-000000000002',
  ts: '2026-11-18T10:00:01.000000Z',
  actor: 'dave-id',
  clientId: 'claude-ai',
  action: 'approval.decision',
  subject: '00000000-0000-4000-8000-0000000000c1',
  decision: 'allow',
  outcome: 'ok',
  correlationId: 'corr-2',
  changesetId: '00000000-0000-4000-8000-0000000000c1',
  details: { step: 1, nested: { b: [1, 'x'], a: true } },
};

const sealed2: SealedChainRow = { ...row2, prevHash: H1, hash: H2 };

describe('AUD-3 AUD-5 audit hash chain', () => {
  it('AUD-3 row 1 with the genesis prev hashes to the fixed vector', () => {
    expect(auditRowHash(row1, GENESIS_HASH)).toBe(H1);
  });

  it('AUD-3 row 2 chained to row 1 hashes to the fixed vector; key order of details does not matter', () => {
    expect(auditRowHash(row2, H1)).toBe(H2);
    expect(auditRowHash({ ...row2, details: { nested: { a: true, b: [1, 'x'] }, step: 1 } }, H1)).toBe(H2);
  });

  it('AUD-3 every field is covered', () => {
    const variants: readonly (readonly [string, ChainRow, string])[] = [
      ['pos', { ...row1, pos: 2 }, GENESIS_HASH],
      ['id', { ...row1, id: '00000000-0000-4000-8000-000000000009' }, GENESIS_HASH],
      ['ts', { ...row1, ts: '2026-11-18T10:00:00.123457Z' }, GENESIS_HASH],
      ['actor', { ...row1, actor: 'bob-id' }, GENESIS_HASH],
      ['clientId', { ...row1, clientId: '' }, GENESIS_HASH],
      ['action', { ...row1, action: 'tool.list' }, GENESIS_HASH],
      ['subject', { ...row1, subject: null }, GENESIS_HASH],
      ['decision', { ...row1, decision: 'allow' }, GENESIS_HASH],
      ['outcome', { ...row1, outcome: 'error' }, GENESIS_HASH],
      ['correlationId', { ...row1, correlationId: 'corr-9' }, GENESIS_HASH],
      ['changesetId', { ...row1, changesetId: '' }, GENESIS_HASH],
      ['details', { ...row1, details: { durationMs: 3 } }, GENESIS_HASH],
      ['prev', row1, H2],
    ];
    expect(variants).toHaveLength(13);
    const hashes = new Set([H1, ...variants.map(([, row, prev]) => auditRowHash(row, prev))]);
    expect(hashes.size).toBe(14);
  });

  it('AUD-3 extra properties on the row do not change the hash', () => {
    const sealed1: SealedChainRow = { ...row1, prevHash: GENESIS_HASH, hash: H1 };
    const archived1 = { ...sealed1, seq: '17', chainPos: 1, extra: undefined };
    expect(auditRowHash(sealed1, GENESIS_HASH)).toBe(H1);
    expect(auditRowHash(archived1, GENESIS_HASH)).toBe(H1);
  });

  it('AUD-5 checkLink reports gap, prev_mismatch and hash_mismatch in that order', () => {
    const head = { pos: 1, hash: H1 };
    expect(checkLink(head, { ...sealed2, pos: 3 })).toBe('gap');
    expect(checkLink(head, { ...sealed2, pos: 3, prevHash: H2, hash: null })).toBe('gap');
    expect(checkLink(head, { ...sealed2, prevHash: H2 })).toBe('prev_mismatch');
    expect(checkLink(head, { ...sealed2, prevHash: null, hash: null })).toBe('prev_mismatch');
    expect(checkLink(head, { ...sealed2, actor: 'mallory-id' })).toBe('hash_mismatch');
    expect(checkLink(head, { ...sealed2, hash: null })).toBe('hash_mismatch');
    expect(checkLink(head, sealed2)).toBeUndefined();
  });

  it('NFR-14 GENESIS_HASH is sha256 and 64 zeros', () => {
    expect(GENESIS_HASH).toBe(`sha256:${'0'.repeat(64)}`);
    expect(AUDIT_CHAIN_FORMAT).toBe('aiops.audit.v1');
  });
});
