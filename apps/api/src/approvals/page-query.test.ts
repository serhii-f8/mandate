import { describe, expect, it } from 'vitest';
import {
  CHANGESET_ID,
  decisionBodySchema,
  encodeItemCursor,
  encodeQueueCursor,
  exclusionBodySchema,
  newSeed,
  parseItemsQuery,
  parseQueueQuery,
  parseSampleQuery,
  submitBodySchema,
} from './page-query.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const UUID = '11111111-1111-4111-8111-111111111111';

describe('NFR-8 page queries and cursors', () => {
  it('NFR-8 limit defaults and bounds', () => {
    expect(parseQueueQuery({})).toEqual({ ok: true, value: { limit: 25 } });
    expect(parseItemsQuery({})).toEqual({ ok: true, value: { limit: 50 } });
    expect(parseQueueQuery({ limit: '1' })).toEqual({ ok: true, value: { limit: 1 } });
    expect(parseItemsQuery({ limit: '100' })).toEqual({ ok: true, value: { limit: 100 } });
    for (const bad of ['0', '101', '1.5', 'abc', ['10', '20'], '', '00000']) {
      expect(parseQueueQuery({ limit: bad })).toEqual({ ok: false });
      expect(parseItemsQuery({ limit: bad })).toEqual({ ok: false });
    }
  });

  it('NFR-8 an item cursor round-trips any targetId and refuses tampering', () => {
    const parsed = parseItemsQuery({ after: encodeItemCursor('ACME-1/ü') });
    expect(parsed).toEqual({ ok: true, value: { limit: 50, after: 'ACME-1/ü' } });
    expect(parseItemsQuery({ after: encodeItemCursor('a\0b') })).toEqual({ ok: false });
    expect(parseItemsQuery({ after: encodeItemCursor('a\nb') })).toEqual({ ok: false });
    for (const bad of ['***', 'x', 'x'.repeat(5000), `${b64('abc')}=`, 'YWJj\n', ['a', 'b']]) {
      expect(parseItemsQuery({ after: bad })).toEqual({ ok: false });
    }
  });

  it('NFR-8 a queue cursor needs [iso, uuid]', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(parseQueueQuery({ after: encodeQueueCursor({ submittedAt: at, id: UUID }) })).toEqual({
      ok: true,
      value: { limit: 25, after: { submittedAt: at, id: UUID } },
    });
    for (const bad of [
      b64('{"a":1}'),
      b64('["2026-01-01T00:00:00.000Z","x"]'),
      b64(`["not a date","${UUID}"]`),
      b64(`["2026-01-01","${UUID}"]`),
      b64(`["2026-01-01T00:00:00.000Z","aaaaaaaa-aaaa-4aaa-8aaa-AAAAAAAAAAAA"]`),
      b64(`["2026-01-01T00:00:00.000Z","${UUID}",1]`),
      '***',
      'x'.repeat(5000),
    ]) {
      expect(parseQueueQuery({ after: bad })).toEqual({ ok: false });
    }
  });

  it('NFR-8 items status filter accepts item statuses only', () => {
    expect(parseItemsQuery({ status: 'excluded' })).toEqual({
      ok: true,
      value: { limit: 50, status: 'excluded' },
    });
    expect(parseItemsQuery({ status: 'deleted' })).toEqual({ ok: false });
    expect(parseItemsQuery({ status: ['written', 'failed'] })).toEqual({ ok: false });
  });

  it('NFR-8 CHANGESET_ID matches canonical UUIDs only', () => {
    expect(CHANGESET_ID.test(UUID)).toBe(true);
    expect(CHANGESET_ID.test('not-a-uuid')).toBe(false);
  });
});

describe('APR-5 sample query', () => {
  it('APR-5 size 1..50, default 10; seed 32 lowercase hex or absent', () => {
    expect(parseSampleQuery({})).toEqual({ ok: true, value: { size: 10, seed: undefined } });
    expect(parseSampleQuery({ size: '50', seed: 'a'.repeat(32) })).toEqual({
      ok: true,
      value: { size: 50, seed: 'a'.repeat(32) },
    });
    expect(parseSampleQuery({ size: '51' })).toEqual({ ok: false });
    expect(parseSampleQuery({ size: '0' })).toEqual({ ok: false });
    expect(parseSampleQuery({ seed: 'A'.repeat(32) })).toEqual({ ok: false });
    expect(parseSampleQuery({ seed: 'a'.repeat(31) })).toEqual({ ok: false });
    expect(parseSampleQuery({ seed: ['a'.repeat(32), 'b'.repeat(32)] })).toEqual({ ok: false });
  });

  it('APR-5 newSeed is 32 hex characters and differs per call', () => {
    const a = newSeed();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newSeed()).not.toBe(a);
  });
});

describe('SEC-8 decision body', () => {
  const ok = { decision: 'approve', hash: `sha256:${'a'.repeat(64)}`, count: 3 };

  it('SEC-8 decisionBodySchema refuses unknown keys, a malformed hash and a negative count', () => {
    expect(decisionBodySchema.safeParse(ok).success).toBe(true);
    expect(decisionBodySchema.safeParse({ ...ok, comment: 'fine' }).success).toBe(true);
    for (const decision of ['reject', 'return'] as const) {
      expect(decisionBodySchema.safeParse({ ...ok, decision }).success).toBe(true);
    }
    for (const key of ['decision', 'hash', 'count'] as const) {
      const rest = Object.fromEntries(Object.entries(ok).filter(([k]) => k !== key));
      expect(decisionBodySchema.safeParse(rest).success).toBe(false);
    }
    expect(decisionBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, hash: 'sha256:abc' }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, count: -1 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, count: 1.5 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, count: 100_000_001 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, decision: 'cancel' }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...ok, comment: 'x'.repeat(10_001) }).success).toBe(
      false,
    );
  });
});

describe('SEC-8 submit and exclusion bodies', () => {
  const hash = `sha256:${'b'.repeat(64)}`;

  it('SEC-8 submit and exclusion bodies are strict', () => {
    expect(submitBodySchema.safeParse({ hash }).success).toBe(true);
    expect(exclusionBodySchema.safeParse({ hash }).success).toBe(true);
    expect(exclusionBodySchema.safeParse({ hash, exclude: ['SKU-1'], include: [] }).success).toBe(true);
    expect(exclusionBodySchema.safeParse({ hash, exclude: Array.from({ length: 1000 }, (_, i) => `t-${String(i)}`) }).success).toBe(true);
    for (const schema of [submitBodySchema, exclusionBodySchema]) {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ hash, extra: 1 }).success).toBe(false);
      expect(schema.safeParse({ hash: 'sha256:abc' }).success).toBe(false);
      expect(schema.safeParse({ hash: `SHA256:${'b'.repeat(64)}` }).success).toBe(false);
    }
    expect(submitBodySchema.safeParse({ hash, exclude: [] }).success).toBe(false);
    for (const key of ['exclude', 'include'] as const) {
      expect(exclusionBodySchema.safeParse({ hash, [key]: Array.from({ length: 1001 }, (_, i) => `t-${String(i)}`) }).success).toBe(false);
      expect(exclusionBodySchema.safeParse({ hash, [key]: 'SKU-1' }).success).toBe(false);
      expect(exclusionBodySchema.safeParse({ hash, [key]: [1] }).success).toBe(false);
      expect(exclusionBodySchema.safeParse({ hash, [key]: ['x'.repeat(513)] }).success).toBe(false);
    }
  });
});
