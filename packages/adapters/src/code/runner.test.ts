import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePresetModule,
  type CodeCallOperation,
  type CodeContext,
  type CodeOperation,
  type CodeReadOperation,
  type CodeWriteOperation,
  type ConnectionSettings,
  type CredentialSource,
  type PresetModule,
} from '@aiops/connector-sdk';
import { CODE_FIXTURE_PRESET_DIR, installFakeItems, startFakeUpstream, type FakeItems, type FakeUpstream } from '@aiops/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionClient, type ConnectionClient } from '../http/client.js';
import { clearTokenCache } from '../http/oauth.js';
import { createCodeRunner, MAX_CODE_REQUESTS, type CodeRunnerDeps } from './runner.js';

/** Typed as unknown so the asymmetric matcher is not an `any` in the expected objects. */
const ANY_MS: unknown = expect.any(Number);
const TOKEN = 'runner-token-0123456789abcdef';
const credential: CredentialSource = { ref: 'runner-cred', scheme: 'bearer', open: () => Promise.resolve({ token: TOKEN }) };

let fixture: PresetModule;
let up: FakeUpstream;
let items: FakeItems;
let seq = 0;

beforeAll(async () => {
  const href = pathToFileURL(join(CODE_FIXTURE_PRESET_DIR, 'lib', 'index.js')).href;
  const mod = (await import(/* @vite-ignore */ href)) as { default: unknown };
  const parsed = parsePresetModule(mod.default);
  if (!parsed.ok) throw new Error(parsed.message);
  fixture = parsed.module;
});

beforeEach(async () => {
  up = await startFakeUpstream();
  items = installFakeItems(up, [
    { id: '1', title: 'one', state: 'open', tags: [] },
    { id: '2', title: 'two', state: 'open', tags: [] },
    { id: '3', title: 'three', state: 'closed', tags: [] },
  ]);
  clearTokenCache();
});
afterEach(async () => {
  vi.useRealTimers();
  await up.close();
});

function settings(over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  seq += 1;
  return {
    id: `code-run-${seq}`,
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    auth: { scheme: 'bearer' },
    ...over,
  };
}

function runner(over: Partial<CodeRunnerDeps> = {}) {
  const clients = new WeakMap<ConnectionSettings, ConnectionClient>();
  const clientOf = (s: ConnectionSettings): ConnectionClient => {
    const c = clients.get(s) ?? createConnectionClient(s);
    clients.set(s, c);
    return c;
  };
  return createCodeRunner({ clientOf, ...over });
}

function op<K extends CodeOperation['kind']>(name: string, kind: K): Extract<CodeOperation, { kind: K }> {
  const found = fixture.operations[name];
  if (found?.kind !== kind) throw new Error(`fixture operation ${name} is not ${kind}`);
  return found as Extract<CodeOperation, { kind: K }>;
}

const readOp = (read: CodeReadOperation['read']): CodeReadOperation => ({ kind: 'read', read });
const writeOp = (write: CodeWriteOperation['write']): CodeWriteOperation => ({ kind: 'write', write });
const callOp = (call: CodeCallOperation['call']): CodeCallOperation => ({ kind: 'call', call });

describe('OPS-5 code runner', () => {
  it('OPS-5 codeRead projects fields and caps max_items like a declarative read', async () => {
    const r = await runner().codeRead({
      connection: settings(),
      name: 'get_many',
      operation: op('get_many', 'read'),
      args: { ids: ['1', '2', '3', '404'], fields: ['id', 'title'] },
      response: { maxItems: 2, fieldsFromArg: 'fields' },
      credential,
    });
    expect(r).toEqual({
      ok: true,
      status: 200,
      durationMs: ANY_MS,
      items: [
        { id: '1', title: 'one' },
        { id: '2', title: 'two' },
      ],
      truncated: true,
    });
    expect(items.requestsTo('GET', '/items/404')).toBe(1);
  });

  it('OPS-5 codeRead of a malformed result is invalid_response', async () => {
    const malformed: unknown[] = [
      undefined,
      [],
      { items: 'x' },
      { items: [1] },
      { items: [[]] },
      { items: [], total: -1 },
      { items: [], total: 1.5 },
      { items: [{ f: () => 1 }], get total(): number {
        throw new Error('hostile getter');
      } },
    ];
    for (const result of malformed) {
      const r = await runner().codeRead({
        connection: settings(),
        name: 'bad',
        operation: readOp(() => Promise.resolve(result as never)),
        args: {},
        response: { maxItems: 10 },
      });
      expect(r).toEqual({ ok: false, code: 'invalid_response', durationMs: ANY_MS, message: 'preset code returned an invalid result' });
    }
  });

  it('OPS-5 SEC-3 a throwing read is upstream_error with a fixed message; onCodeError gets the scrubbed, cut message', async () => {
    const events: { connection: string; operation: string; kind: string; message: string }[] = [];
    const run = runner({ onCodeError: (e) => events.push(e) });
    const connection = settings();
    const r = await run.codeRead({
      connection,
      name: 'leaky',
      operation: readOp(() => Promise.reject(new Error(`call failed: Bearer ${TOKEN}\r\nnext line ${'x'.repeat(1000)}`))),
      args: {},
      response: { maxItems: 10 },
      credential,
    });
    expect(r).toEqual({ ok: false, code: 'upstream_error', durationMs: ANY_MS, message: 'preset code failed' });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.connection).toBe(connection.id);
    expect(event?.operation).toBe('leaky');
    expect(event?.kind).toBe('read');
    expect(event?.message.startsWith('call failed: Bearer [REDACTED]  next line x')).toBe(true);
    expect(event?.message).not.toContain(TOKEN);
    expect(event?.message.length).toBeLessThanOrEqual(500);

    // The fixture's own failing operation: the thrown text never reaches the outcome.
    const boom = await runner().codeRead({ connection: settings(), name: 'boom', operation: op('boom', 'read'), args: {}, response: { maxItems: 1 } });
    expect(boom).toEqual({ ok: false, code: 'upstream_error', durationMs: ANY_MS, message: 'preset code failed' });
    expect(JSON.stringify(boom)).not.toContain('token-sentinel');
  });

  it('OPS-5 codeWrite returns one outcome per record; a wrong count is invalid_response', async () => {
    const r = await runner().codeWrite({
      connection: settings(),
      name: 'set_tags',
      operation: op('set_tags', 'write'),
      records: [
        { id: '1', tags: ['a'] },
        { id: '2', tags: ['unknown'] },
      ],
      args: {},
      credential,
    });
    expect(r).toEqual({ ok: true, outcomes: ['ok', 'failed'], durationMs: ANY_MS });
    expect(items.items.get('1')?.tags).toEqual(['a']);

    for (const outcomes of [['ok'], ['ok', 'maybe'], 'ok', [1, 2]]) {
      const bad = await runner().codeWrite({
        connection: settings(),
        name: 'bad',
        operation: writeOp(() => Promise.resolve(outcomes as never)),
        records: [{ id: '1' }, { id: '2' }],
        args: {},
      });
      expect(bad).toEqual({ ok: false, code: 'invalid_response', durationMs: ANY_MS, retriable: false });
    }
    const thrown = await runner().codeWrite({
      connection: settings(),
      name: 'throws',
      operation: writeOp(() => Promise.reject(new Error('x'))),
      records: [{ id: '1' }],
      args: {},
    });
    expect(thrown).toEqual({ ok: false, code: 'upstream_error', durationMs: ANY_MS, retriable: true });
  });

  it('OPS-5 codeWrite passes the change-set arguments to the code', async () => {
    let seen: unknown;
    await runner().codeWrite({
      connection: settings(),
      name: 'args',
      operation: writeOp((_ctx, records, args) => {
        seen = args;
        return Promise.resolve(records.map(() => 'ok' as const));
      }),
      records: [{ id: '1' }],
      args: { owner: 'acme' },
    });
    expect(seen).toEqual({ owner: 'acme' });
  });

  it('OPS-5 codeWrite calls onProgress for every send', async () => {
    let progress = 0;
    await runner().codeWrite({
      connection: settings(),
      name: 'set_tags',
      operation: op('set_tags', 'write'),
      records: [
        { id: '1', tags: ['a'] },
        { id: '2', tags: ['b'] },
        { id: '3', tags: ['c'] },
      ],
      args: {},
      credential,
      onProgress: () => (progress += 1),
    });
    expect(progress).toBe(3);
    expect(items.requestsTo('PUT', '/items/3/tags')).toBe(1);
  });

  it('OPS-5 codeCall maps definite and indefinite failures', async () => {
    const run = runner();
    const call = (operation: CodeCallOperation) => run.codeCall({ connection: settings(), name: 'ping', operation, args: { a: 1 }, credential });
    expect(await call(op('ping', 'call'))).toEqual({ ok: true, durationMs: ANY_MS });
    items.failNext('POST', '/ping', 400);
    expect(await call(op('ping', 'call'))).toEqual({ ok: false, definite: true, code: 'rejected', durationMs: ANY_MS });
    items.failNext('POST', '/ping', 503);
    expect(await call(op('ping', 'call'))).toEqual({ ok: false, definite: false, code: 'upstream_error', durationMs: ANY_MS });
    expect(await call(callOp(() => Promise.resolve({ ok: 'yes' } as never)))).toEqual({
      ok: false,
      definite: false,
      code: 'invalid_response',
      durationMs: ANY_MS,
    });
    expect(await call(callOp(() => Promise.resolve({ ok: false } as never)))).toEqual({
      ok: false,
      definite: false,
      code: 'invalid_response',
      durationMs: ANY_MS,
    });
    expect(await call(callOp(() => Promise.reject(new Error('x'))))).toEqual({ ok: false, definite: false, code: 'upstream_error', durationMs: ANY_MS });
    expect(
      await call(
        callOp(() => {
          throw new Error('synchronous');
        }),
      ),
    ).toEqual({ ok: false, definite: false, code: 'upstream_error', durationMs: ANY_MS });
  });

  it('OPS-5 a code read that never resolves ends at the read deadline as timeout', async () => {
    vi.useFakeTimers();
    let ctx: CodeContext | undefined;
    const pending = runner().codeRead({
      connection: settings(),
      name: 'hangs',
      operation: readOp((c) => {
        ctx = c;
        return new Promise(() => undefined);
      }),
      args: {},
      response: { maxItems: 1 },
      credential,
    });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    expect(ctx?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, code: 'timeout', durationMs: ANY_MS, message: 'preset code did not finish within 60000 ms' });
    expect(ctx?.signal.aborted).toBe(true);
    // F26: a send the code starts after the deadline is refused without a request.
    expect(await ctx?.http.send({ method: 'GET', path: '/items/1' })).toEqual({ ok: false, code: 'timeout' });
    expect(up.requests.length).toBe(0);
  });

  it('OPS-5 writes and calls end at the configured write deadline as timeout', async () => {
    vi.useFakeTimers();
    const run = runner({ codeDeadlines: { readMs: 1000, writeMs: 5000 } });
    const write = run.codeWrite({
      connection: settings(),
      name: 'hangs',
      operation: writeOp(() => new Promise(() => undefined)),
      records: [{ id: '1' }],
      args: {},
    });
    const call = run.codeCall({ connection: settings(), name: 'hangs', operation: callOp(() => new Promise(() => undefined)), args: {} });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await write).toEqual({ ok: false, code: 'timeout', durationMs: ANY_MS, retriable: true });
    expect(await call).toEqual({ ok: false, definite: false, code: 'timeout', durationMs: ANY_MS });
  });

  it('OPS-5 a send after the operation finished is refused without a request', async () => {
    let ctx: CodeContext | undefined;
    await runner().codeRead({
      connection: settings(),
      name: 'leaves',
      operation: readOp((c) => {
        ctx = c;
        return Promise.resolve({ items: [] });
      }),
      args: {},
      response: { maxItems: 1 },
    });
    expect(await ctx?.http.send({ method: 'GET', path: '/items/1' })).toEqual({ ok: false, code: 'timeout' });
    expect(up.requests.length).toBe(0);
  });

  it('OPS-5 code operations on an mcp connection answer mapping without running the code', async () => {
    let ran = false;
    const connection = settings({ kind: 'mcp' });
    const run = runner();
    const r = await run.codeRead({
      connection,
      name: 'x',
      operation: readOp(() => {
        ran = true;
        return Promise.resolve({ items: [] });
      }),
      args: {},
      response: { maxItems: 1 },
    });
    expect(r).toMatchObject({ ok: false, code: 'mapping' });
    expect(await run.codeWrite({ connection, name: 'x', operation: writeOp(() => Promise.resolve([])), records: [], args: {} })).toMatchObject({
      ok: false,
      code: 'mapping',
      retriable: false,
    });
    expect(await run.codeCall({ connection, name: 'x', operation: callOp(() => Promise.resolve({ ok: true })), args: {} })).toMatchObject({
      ok: false,
      code: 'mapping',
      definite: true,
    });
    expect(ran).toBe(false);
  });

  it('OPS-5 the request limit per invocation is 1000', () => {
    expect(MAX_CODE_REQUESTS).toBe(1000);
  });
});
