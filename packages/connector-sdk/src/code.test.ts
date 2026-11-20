import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  parsePresetModule,
  recordOutcomeOf,
  type CodeAdapter,
  type CodeArgs,
  type CodeContext,
  type CodeWriteContext,
  type CodeWriteDirection,
  type CodeWriteOperation,
  type PresetModule,
  type RecordOutcome,
  type WriteRecord,
} from './index.js';

const read = { kind: 'read', read: () => Promise.resolve({ items: [] }) };
const write = { kind: 'write', write: () => Promise.resolve([]) };
const call = { kind: 'call', call: () => Promise.resolve({ ok: true }) };

function message(value: unknown): string | undefined {
  const r = parsePresetModule(value);
  return r.ok ? undefined : r.message;
}

describe('OPS-5 parsePresetModule', () => {
  it('OPS-5 accepts read, write and call operations by name', async () => {
    const value = { operations: { list_labels: read, add_labels: write, close_issue: call } };
    const r = parsePresetModule(value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const module: PresetModule = r.module;
    expect(Object.keys(module.operations)).toEqual(['list_labels', 'add_labels', 'close_issue']);
    const op = module.operations.close_issue;
    expect(op?.kind).toBe('call');
    if (op?.kind === 'call') expect(await op.call({} as CodeContext, {})).toEqual({ ok: true });
  });

  it('OPS-5 refuses a non-object, a missing operations record, an unknown kind, a kind without its function and a bad name', () => {
    expect(message(null)).toBe('operations must be an object');
    expect(message('module')).toBe('operations must be an object');
    expect(message({})).toBe('operations must be an object');
    expect(message({ operations: [] })).toBe('operations must be an object');
    expect(message({ operations: 'x' })).toBe('operations must be an object');
    expect(message({ operations: { list: { kind: 'stream', read: read.read } } })).toBe('operation list: unknown kind');
    expect(message({ operations: { list: 42 } })).toBe('operation list: unknown kind');
    expect(message({ operations: { add: { kind: 'write' } } })).toBe('operation add: kind write needs a write function');
    expect(message({ operations: { add: { kind: 'write', read: read.read } } })).toBe('operation add: kind write needs a write function');
    expect(message({ operations: { get: { kind: 'read', read: 'no' } } })).toBe('operation get: kind read needs a read function');
    expect(message({ operations: { close: { kind: 'call' } } })).toBe('operation close: kind call needs a call function');
    expect(message({ operations: { BadName: read } })).toBe('operation name BadName is invalid');
    expect(message({ operations: { '1st': read } })).toBe('operation name 1st is invalid');
    expect(message({ operations: { 'a-b': read } })).toBe('operation name a-b is invalid');
    expect(message({ operations: { ['a'.repeat(63)]: read } })).toBe(undefined);
    expect(message({ operations: { ['a'.repeat(64)]: read } })).toBe(`operation name ${'a'.repeat(64)} is invalid`);
    expect(message({ operations: { ['a'.repeat(65)]: read } })).toBe('operation name (value) is invalid');
  });
});

describe('OPS-5 EXE-8 code write direction', () => {
  it('OPS-5 EXE-8 NFR-18 a code write receives a context with a forward or rollback direction (additive in 0.6.0)', () => {
    expectTypeOf<CodeWriteDirection>().toEqualTypeOf<'forward' | 'rollback'>();
    expectTypeOf<CodeWriteContext['direction']>().toEqualTypeOf<CodeWriteDirection>();
    expectTypeOf<CodeWriteContext>().toExtend<CodeContext>();
    expectTypeOf<Parameters<CodeWriteOperation['write']>[0]>().toEqualTypeOf<CodeWriteContext>();
    // A write declared against the plain CodeContext still satisfies the interface.
    expectTypeOf<(ctx: CodeContext, records: readonly WriteRecord[], args: CodeArgs) => Promise<readonly RecordOutcome[]>>().toExtend<
      CodeWriteOperation['write']
    >();
    // The adapter input names the direction; absent means forward.
    expectTypeOf<Parameters<CodeAdapter['codeWrite']>[0]['direction']>().toEqualTypeOf<CodeWriteDirection | undefined>();
  });
});

describe('OPS-6 recordOutcomeOf', () => {
  it('OPS-6 a 2xx, or a 2xx the client could not read, is ok; a retriable failure is retriable; any other failure is failed', () => {
    expect(recordOutcomeOf({ ok: true, status: 204, durationMs: 1 })).toBe('ok');
    expect(recordOutcomeOf({ ok: false, code: 'invalid_response', status: 200, durationMs: 1, retriable: false })).toBe('ok');
    expect(recordOutcomeOf({ ok: false, code: 'http_status', status: 503, durationMs: 1, retriable: true })).toBe('retriable');
    expect(recordOutcomeOf({ ok: false, code: 'http_status', status: 404, durationMs: 1, retriable: false })).toBe('failed');
    expect(recordOutcomeOf({ ok: false, code: 'credential_missing', durationMs: 0, retriable: false })).toBe('failed');
  });
});
