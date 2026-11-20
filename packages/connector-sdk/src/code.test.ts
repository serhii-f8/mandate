import { describe, expect, it } from 'vitest';
import { parsePresetModule, type CodeContext, type PresetModule } from './index.js';

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
