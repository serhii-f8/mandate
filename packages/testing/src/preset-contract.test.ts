// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CodeAdapter, ConnectionSettings, RecordSendOutcome, RecordWriteAdapter, UpstreamMapping } from '@mandate/connector-sdk';
import { describe, expect, it } from 'vitest';
import { contractWrite } from './preset-contract.js';

const connection = { id: 'items', baseUrl: 'https://items.example.test' } as unknown as ConnectionSettings;
const mapping: UpstreamMapping = { method: 'PATCH', path: '/items/{id}', pathParams: {}, query: {}, headers: {}, response: { maxItems: 10 } };

/** Answers the scripted outcome per record ID; code operations are not used. */
function adapter(script: ReadonlyMap<unknown, RecordSendOutcome>): RecordWriteAdapter & CodeAdapter {
  return {
    writeRecord: (input) => Promise.resolve(script.get(input.record.id) ?? { ok: true, status: 200, durationMs: 1 }),
    codeRead: () => Promise.reject(new Error('not used')),
    codeWrite: () => Promise.reject(new Error('not used')),
    codeCall: () => Promise.reject(new Error('not used')),
  };
}

describe('OPS-6 contractWrite', () => {
  it('OPS-6 maps per-record answers as production does: an unreadable 2xx is ok', async () => {
    const script = new Map<unknown, RecordSendOutcome>([
      ['2', { ok: false, code: 'invalid_response', status: 200, durationMs: 1, retriable: false }],
      ['3', { ok: false, code: 'http_status', status: 429, durationMs: 1, retriable: true }],
      ['4', { ok: false, code: 'http_status', status: 404, durationMs: 1, retriable: false }],
    ]);
    const outcomes = await contractWrite({
      adapter: adapter(script),
      connection,
      binding: { kind: 'http', mapping },
      records: ['1', '2', '3', '4'].map((id) => ({ id })),
      args: {},
    });
    expect(outcomes).toEqual(['ok', 'ok', 'retriable', 'failed']);
  });
});
