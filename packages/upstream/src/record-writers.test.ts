import { describe, expect, it } from 'vitest';
import type { LoadedConfiguration } from '@aiops/config';
import type {
  CodeAdapter,
  CodeCallResult,
  CodeWriteOutcome,
  ReadOutcome,
  RecordSendOutcome,
  RecordWriteAdapter,
} from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { loadCodeFixture } from '../test/code-fixture.js';
import type { UpstreamCallLog } from './read.js';
import { createCodeRecordWriter, createPerRecordWriter, type DirectWriterDeps } from './record-writers.js';

const SECRET = 'unit-only-fake-token';
const TITLE = 'a-distinctive-record-title';
const ARGS = { ids: ['1', '2', '3'], changes: { title: TITLE } };

class MemoryVault implements CredentialVault {
  readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();
  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    const row = this.rows.get(ref);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

type RecordInput = Parameters<RecordWriteAdapter['writeRecord']>[0];
type CodeWriteInput = Parameters<CodeAdapter['codeWrite']>[0];

const OK_SEND: RecordSendOutcome = { ok: true, status: 200, durationMs: 4 };

/**
 * Honours the SDK contracts (ruling F13): records every request, answers scripted outcomes per
 * record ID, and counts requests in flight; each send waits one macrotask so concurrent sends overlap.
 */
class FakeRecordAdapter implements RecordWriteAdapter, CodeAdapter {
  readonly records: RecordInput[] = [];
  readonly codeWrites: CodeWriteInput[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly script = new Map<unknown, RecordSendOutcome>();
  /** Record IDs whose send rejects (an adapter bug or an aborted runtime), and extra macrotask waits per ID. */
  readonly rejectFor = new Map<unknown, Error>();
  readonly extraTicks = new Map<unknown, number>();
  readonly settled: unknown[] = [];
  codeOutcome: CodeWriteOutcome = { ok: true, outcomes: [], durationMs: 9 };

  async writeRecord(input: RecordInput): Promise<RecordSendOutcome> {
    this.records.push(input);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const ticks = 1 + (this.extraTicks.get(input.record.id) ?? 0);
    for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
    this.inFlight -= 1;
    this.settled.push(input.record.id);
    const error = this.rejectFor.get(input.record.id);
    if (error !== undefined) throw error;
    return this.script.get(input.record.id) ?? OK_SEND;
  }
  codeRead(): Promise<ReadOutcome> {
    throw new Error('not used');
  }
  codeWrite(input: CodeWriteInput): Promise<CodeWriteOutcome> {
    this.codeWrites.push(input);
    input.onProgress?.();
    return Promise.resolve(this.codeOutcome);
  }
  codeCall(): Promise<CodeCallResult> {
    throw new Error('not used');
  }
}

async function setup(operationId: string, maxConcurrency = 2, configuration?: LoadedConfiguration) {
  const config = configuration ?? (await loadCodeFixture(maxConcurrency));
  const adapter = new FakeRecordAdapter();
  const vault = new MemoryVault();
  await vault.put({ ref: 'items-token', scheme: 'bearer', secret: { token: SECRET }, actor: 'test' });
  const lines: UpstreamCallLog[] = [];
  const deps: DirectWriterDeps = { configuration: config, vault, adapter, operationId, correlationId: 'corr-w', args: ARGS, log: (l) => lines.push(l) };
  const beats = { count: 0 };
  const heartbeat = (): void => void (beats.count += 1);
  return { config, adapter, vault, lines, deps, beats, heartbeat };
}

const records = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: TITLE }));

describe('OPS-5 OPS-6 direct writers', () => {
  it('OPS-6 the per-record writer PATCHes each record once with the change-set arguments and maps outcomes', async () => {
    const s = await setup('fixture.update');
    const writer = createPerRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a per-record writer');
    s.adapter.script.set('2', { ok: false, code: 'invalid_response', status: 200, durationMs: 3, retriable: false });
    s.adapter.script.set('3', { ok: false, code: 'http_status', status: 404, durationMs: 2, retriable: false });
    s.adapter.script.set('4', { ok: false, code: 'credential_missing', durationMs: 0, retriable: false });
    const sent = records(4);
    const res = await writer.write(sent, s.heartbeat);
    // A 2xx the client could not read is `ok`: the verify read decides. Other non-retriable failures are `failed`.
    expect(res).toEqual({ ok: true, states: ['ok', 'ok', 'failed', 'failed'] });
    const binding = s.config.bindings.get('fixture.update');
    if (binding?.kind !== 'http') throw new Error('fixture.update has no HTTP binding');
    expect(binding.mapping.method).toBe('PATCH');
    expect(s.adapter.records.map((r) => r.record)).toEqual(sent);
    for (const input of s.adapter.records) {
      expect(input.mapping).toBe(binding.mapping);
      expect(input.args).toBe(ARGS);
      expect(input.connection).toBe(s.config.connectionSettings.get('items'));
      expect(await input.credential?.open()).toEqual({ token: SECRET });
    }
    // One heartbeat after each response.
    expect(s.beats.count).toBe(4);
    // SEC-3: one log line per request, identifiers, method, status and timing only.
    expect(s.lines).toEqual([
      { correlationId: 'corr-w', operation: 'fixture.update', connection: 'items', method: 'PATCH', status: 200, durationMs: 4 },
      { correlationId: 'corr-w', operation: 'fixture.update', connection: 'items', method: 'PATCH', status: 200, durationMs: 3, errorCode: 'invalid_response' },
      { correlationId: 'corr-w', operation: 'fixture.update', connection: 'items', method: 'PATCH', status: 404, durationMs: 2, errorCode: 'http_status' },
      { correlationId: 'corr-w', operation: 'fixture.update', connection: 'items', method: 'PATCH', durationMs: 0, errorCode: 'credential_missing' },
    ]);
    const text = JSON.stringify(s.lines);
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(SECRET);
  });

  it('OPS-6 CONN-6 the per-record writer keeps at most max_concurrency requests in flight', async () => {
    const s = await setup('fixture.update', 2);
    const writer = createPerRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a per-record writer');
    const res = await writer.write(records(10), s.heartbeat);
    expect(res).toEqual({ ok: true, states: Array<string>(10).fill('ok') });
    expect(s.adapter.records).toHaveLength(10);
    expect(s.adapter.maxInFlight).toBeLessThanOrEqual(2);
    // The limit is used, not serialised to one.
    expect(s.adapter.maxInFlight).toBe(2);
    expect(s.beats.count).toBe(10);
  });

  it.each([
    ['429', { ok: false, code: 'http_status', status: 429, durationMs: 1, retriable: true }],
    ['503', { ok: false, code: 'http_status', status: 503, durationMs: 1, retriable: true }],
    ['timeout', { ok: false, code: 'timeout', durationMs: 1, retriable: true }],
    ['network', { ok: false, code: 'network', durationMs: 1, retriable: true }],
    ['busy', { ok: false, code: 'busy', durationMs: 0, retriable: true }],
  ] as const)('OPS-6 NFR-2 the per-record writer starts no request after a retriable answer (%s)', async (_name, outcome) => {
    const s = await setup('fixture.update', 1);
    const writer = createPerRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a per-record writer');
    s.adapter.script.set('2', outcome);
    const res = await writer.write(records(5), s.heartbeat);
    // Unsent records answer `retriable`: the batch is retried and read-before-write sorts out what was written.
    expect(res).toEqual({ ok: true, states: ['ok', 'retriable', 'retriable', 'retriable', 'retriable'] });
    expect(s.adapter.records.map((r) => r.record.id)).toEqual(['1', '2']);
  });

  it('OPS-6 NFR-2 requests already in flight finish after a retriable answer; none start', async () => {
    const s = await setup('fixture.update', 2);
    const writer = createPerRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a per-record writer');
    s.adapter.script.set('1', { ok: false, code: 'http_status', status: 503, durationMs: 1, retriable: true });
    const res = await writer.write(records(6), s.heartbeat);
    expect(res).toEqual({ ok: true, states: ['retriable', 'ok', 'retriable', 'retriable', 'retriable', 'retriable'] });
    expect(s.adapter.records.map((r) => r.record.id)).toEqual(['1', '2']);
  });

  it('OPS-6 NFR-2 a rejected send stops new requests and propagates only after in-flight requests settle', async () => {
    const s = await setup('fixture.update', 2);
    const writer = createPerRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a per-record writer');
    const broken = new Error('adapter failed');
    s.adapter.rejectFor.set('1', broken);
    // Record 2 is still in flight when record 1 rejects.
    s.adapter.extraTicks.set('2', 3);
    let settledAtRejection: unknown[] = [];
    await expect(
      writer.write(records(6), s.heartbeat).catch((error: unknown) => {
        settledAtRejection = [...s.adapter.settled];
        throw error;
      }),
    ).rejects.toBe(broken);
    // The error surfaces only once the lane with record 2 has settled.
    expect(settledAtRejection).toEqual(['1', '2']);
    // Nothing starts after the rejection, then or later.
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(s.adapter.records.map((r) => r.record.id)).toEqual(['1', '2']);
  });

  it('SEC-2 an unusable credential answers credential_unusable and sends nothing', async () => {
    const s = await setup('fixture.update');
    await s.vault.put({ ref: 'items-token', scheme: 'no-such-scheme', secret: { token: SECRET }, actor: 'test' });
    const perRecord = createPerRecordWriter(s.deps);
    const code = createCodeRecordWriter({ ...s.deps, operationId: 'fixture.set_tags' });
    expect(await perRecord?.write(records(2), s.heartbeat)).toEqual({ ok: false, code: 'credential_unusable', retriable: false });
    expect(await code?.write(records(2), s.heartbeat)).toEqual({ ok: false, code: 'credential_unusable', retriable: false });
    expect(s.adapter.records).toEqual([]);
    expect(s.adapter.codeWrites).toEqual([]);
  });

  it('OPS-5 the code writer passes records and arguments and maps a wrong count to no_outcome-bound failure', async () => {
    const s = await setup('fixture.set_tags');
    const writer = createCodeRecordWriter(s.deps);
    if (writer === undefined) throw new Error('expected a code writer');
    const sent = [{ id: '1', tags: ['a'] }, { id: '2', tags: ['b'] }, { id: '3', tags: ['unknown'] }];
    s.adapter.codeOutcome = { ok: true, outcomes: ['ok', 'retriable', 'failed'], durationMs: 9 };
    expect(await writer.write(sent, s.heartbeat)).toEqual({ ok: true, states: ['ok', 'retriable', 'failed'] });
    const binding = s.config.bindings.get('fixture.set_tags');
    if (binding?.kind !== 'code') throw new Error('fixture.set_tags has no code binding');
    const [input] = s.adapter.codeWrites;
    expect(input?.name).toBe(binding.name);
    expect(input?.operation).toBe(s.config.codeOperations.get('fixture.set_tags'));
    expect(input?.records).toBe(sent);
    expect(input?.args).toBe(ARGS);
    expect(input?.connection).toBe(s.config.connectionSettings.get('items'));
    expect(await input?.credential?.open()).toEqual({ token: SECRET });
    // onProgress is the heartbeat.
    expect(s.beats.count).toBe(1);
    expect(s.lines).toEqual([{ correlationId: 'corr-w', operation: 'fixture.set_tags', connection: 'items', method: 'CODE', durationMs: 9 }]);

    // T9-M2: a shorter or longer answer cannot be aligned with the records: non-retriable invalid_response (no_outcome).
    s.adapter.codeOutcome = { ok: true, outcomes: ['ok', 'ok'], durationMs: 9 };
    expect(await writer.write(sent, s.heartbeat)).toEqual({ ok: false, code: 'invalid_response', retriable: false });
    s.adapter.codeOutcome = { ok: true, outcomes: ['ok', 'ok', 'ok', 'failed'], durationMs: 9 };
    expect(await writer.write(sent, s.heartbeat)).toEqual({ ok: false, code: 'invalid_response', retriable: false });
    expect(s.lines.at(-1)).toEqual({ correlationId: 'corr-w', operation: 'fixture.set_tags', connection: 'items', method: 'CODE', durationMs: 9, errorCode: 'invalid_response' });

    // A failure keeps its fixed code and retriability; status and duration stay behind.
    s.adapter.codeOutcome = { ok: false, code: 'timeout', durationMs: 300_000, retriable: true };
    expect(await writer.write(sent, s.heartbeat)).toEqual({ ok: false, code: 'timeout', retriable: true });
    s.adapter.codeOutcome = { ok: false, code: 'upstream_error', status: 500, durationMs: 5, retriable: false };
    expect(await writer.write(sent, s.heartbeat)).toEqual({ ok: false, code: 'upstream_error', retriable: false });
    expect(s.lines.at(-1)).toEqual({ correlationId: 'corr-w', operation: 'fixture.set_tags', connection: 'items', method: 'CODE', status: 500, durationMs: 5, errorCode: 'upstream_error' });
    expect(JSON.stringify(s.lines)).not.toContain(SECRET);
  });

  it('OPS-6 both writers answer undefined for a binding of another kind', async () => {
    const s = await setup('fixture.update');
    const base = { ...s.deps };
    // Per-record: HTTP, non-GET, without bulk, for a manifest write only.
    for (const id of ['fixture.set_tags', 'fixture.search', 'fixture.get_many', 'fixture.ping', 'fixture.boom', 'no.such']) {
      expect(createPerRecordWriter({ ...base, operationId: id })).toBeUndefined();
    }
    // Code: kind code with a write operation.
    for (const id of ['fixture.update', 'fixture.search', 'fixture.get_many', 'fixture.ping', 'fixture.boom', 'no.such']) {
      expect(createCodeRecordWriter({ ...base, operationId: id })).toBeUndefined();
    }
    // A code binding whose module operation is not a write fails closed.
    const ping = s.config.codeOperations.get('fixture.ping');
    if (ping === undefined) throw new Error('fixture.ping has no code operation');
    const tampered: LoadedConfiguration = { ...s.config, codeOperations: new Map([...s.config.codeOperations, ['fixture.set_tags', ping]]) };
    expect(createCodeRecordWriter({ ...base, configuration: tampered, operationId: 'fixture.set_tags' })).toBeUndefined();
    // Creating a writer has no side effects.
    expect(s.adapter.records).toEqual([]);
    expect(s.adapter.codeWrites).toEqual([]);
  });
});
