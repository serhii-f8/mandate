import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration, type PinEvaluation } from '@aiops/config';
import {
  mcpToolHash,
  type BulkStatusOutcome,
  type BulkSubmitOutcome,
  type CallOutcome,
  type CodeAdapter,
  type CodeCallResult,
  type McpToolDefinition,
  type ToolListOutcome,
  type UpstreamResolver,
  type WriteAdapter,
  type WriteErrorCode,
} from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault, OpaqueNotSentCode } from '@aiops/core';
import { createOpaqueCaller, type OpaqueCallerDeps } from './opaque-caller.js';
import { verifyPinNow, type ToolLister } from './pin-monitor.js';
import type { UpstreamCallLog } from './read.js';
import { loadCodeFixture } from '../test/code-fixture.js';

const SEND: McpToolDefinition = { name: 'send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } };
const PIN = mcpToolHash(SEND);

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: shop-key, auth: { scheme: bearer } }
  - { id: tools, adapter: mcp, mcp_url: http://tools.example.test/mcp, credential_ref: tools-key, auth: { scheme: bearer }, pin_check_seconds: 100 }
`,
  'operations.yaml': `version: 1
operations:
  - id: shop.get
    connection: shop
    risk: read
    description: Read.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: shop.bulk
    connection: shop
    risk: write
    description: Bulk.
    upstream:
      method: POST
      path: /async/bulk/V1/products
      bulk:
        body: { wrap: product }
        batch_id: bulk_uuid
        status: { method: GET, path: '/V1/bulk/{batch_id}/detailed-status', items: operations_list, index: id, state: status, states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, changes: { type: object, properties: { description: { type: string } }, additionalProperties: false } }
      required: [changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [description]
      read_before: { operation: shop.get, ids_arg: skus }
      rollback: { strategy: replay_previous_state }
  - id: shop.plain
    connection: shop
    risk: write_opaque
    description: Plain opaque write.
    upstream: { method: PUT, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
    input_schema: { type: object, properties: { sku: { type: string } }, required: [sku] }
  - id: shop.keyed
    connection: shop
    risk: write_opaque
    description: Opaque write with an idempotency key.
    upstream: { method: POST, path: /V1/orders, idempotency: { header: Idempotency-Key } }
    input_schema: { type: object }
  - id: tools.send
    connection: tools
    risk: write_opaque
    description: Send.
    upstream: { tool: send, pin: ${PIN} }
`,
};

function listOf(...definitions: McpToolDefinition[]): ToolListOutcome {
  return { ok: true, tools: definitions.map((definition) => ({ definition, hash: mcpToolHash(definition) })), dropped: 0, durationMs: 3 };
}

const resolver: UpstreamResolver = {
  resolveSpec: () => Promise.resolve({ ok: true, catalog: [] }),
  resolveTools: () => Promise.resolve(listOf(SEND)),
};
const loaded = await loadConfigurationSources(
  Object.entries(SOURCES).map(([file, text]) => ({ file, text })),
  { resolver },
);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

const SECRET = 'unit-only-fake-token';
const ARG_VALUE = 'a-distinctive-argument-value';
const ARGS = { sku: ARG_VALUE };
const KEY = 'cs-1:call';

class MemoryVault implements CredentialVault {
  readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();
  handles = 0;
  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    this.handles += 1;
    const row = this.rows.get(ref);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

type CallInput = Parameters<WriteAdapter['callOnce']>[0];

/** Honours the `callOnce` contract: `not_sent` without calling `beforeSend`; otherwise the hook, then one send. */
class FakeWriteAdapter implements WriteAdapter {
  readonly calls: CallInput[] = [];
  sent = 0;
  constructor(public outcome: CallOutcome = { result: 'accepted', status: 200, durationMs: 7 }) {}
  submitBulk(): Promise<BulkSubmitOutcome> {
    throw new Error('not used');
  }
  bulkStatus(): Promise<BulkStatusOutcome> {
    throw new Error('not used');
  }
  async callOnce(input: CallInput): Promise<CallOutcome> {
    this.calls.push(input);
    if (this.outcome.result === 'not_sent') return this.outcome;
    await input.beforeSend();
    this.sent += 1;
    return this.outcome;
  }
}

const ok: PinEvaluation = { state: 'ok', liveHash: PIN };

async function setup(operationId: string, overrides: Partial<OpaqueCallerDeps> = {}, scheme = 'bearer') {
  const adapter = new FakeWriteAdapter();
  const vault = new MemoryVault();
  await vault.put({ ref: 'shop-key', scheme, secret: { token: SECRET }, actor: 'test' });
  await vault.put({ ref: 'tools-key', scheme, secret: { token: SECRET }, actor: 'test' });
  const lines: UpstreamCallLog[] = [];
  const pinChecks: string[] = [];
  const deps: OpaqueCallerDeps = {
    configuration: CONFIG,
    vault,
    adapter,
    operationId,
    correlationId: 'corr-o',
    pinCheck: (id) => {
      pinChecks.push(id);
      return Promise.resolve(ok);
    },
    log: (l) => lines.push(l),
    ...overrides,
  };
  const caller = createOpaqueCaller(deps);
  if (caller === undefined) throw new Error(`expected an opaque caller for ${operationId}`);
  return { adapter, vault, lines, pinChecks, caller };
}

const hooked = () => {
  const seen = { calls: 0 };
  return { seen, beforeSend: () => Promise.resolve(void (seen.calls += 1)) };
};

describe('EXE-4 CONN-4 createOpaqueCaller', () => {
  it('EXE-4 HTTP: passes the key and beforeSend through; names the lower-case header only with an idempotency header', async () => {
    const keyed = await setup('shop.keyed');
    expect(keyed.caller.idempotencyHeader).toBe('idempotency-key');
    const { seen, beforeSend } = hooked();
    await expect(keyed.caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend })).resolves.toEqual({ kind: 'accepted' });
    const binding = CONFIG.bindings.get('shop.keyed');
    if (binding?.kind !== 'http') throw new Error('fixture has no HTTP binding');
    const [input] = keyed.adapter.calls;
    expect(input?.target).toEqual({ kind: 'http', mapping: binding.mapping });
    expect(input?.connection).toBe(CONFIG.connectionSettings.get('shop'));
    expect(input?.args).toBe(ARGS);
    // T6 minor 3: the key is passed whenever the binding declares idempotency.
    expect(input?.idempotencyKey).toBe(KEY);
    expect(input?.beforeSend).toBe(beforeSend);
    expect(await input?.credential?.open()).toEqual({ token: SECRET });
    expect(seen.calls).toBe(1);
    expect(keyed.adapter.sent).toBe(1);
    // HTTP needs no pin check.
    expect(keyed.pinChecks).toEqual([]);

    const plain = await setup('shop.plain');
    expect(plain.caller.idempotencyHeader).toBeUndefined();
    await plain.caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend });
    expect(plain.adapter.calls[0]).not.toHaveProperty('idempotencyKey');
  });

  it('MCP: the tool target after an ok fresh pin check, never idempotent and no key', async () => {
    const { adapter, caller, pinChecks } = await setup('tools.send');
    expect(caller.idempotencyHeader).toBeUndefined();
    await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend })).resolves.toEqual({ kind: 'accepted' });
    expect(pinChecks).toEqual(['tools.send']);
    expect(adapter.calls[0]?.target).toEqual({ kind: 'mcp', tool: 'send' });
    expect(adapter.calls[0]).not.toHaveProperty('idempotencyKey');
  });

  it('CONN-4 a changed or missing pin is not_sent/upstream_changed and the adapter is not called', async () => {
    for (const evaluation of [
      { state: 'changed', liveHash: 'other' },
      { state: 'missing', liveHash: null },
    ] satisfies PinEvaluation[]) {
      const { adapter, caller } = await setup('tools.send', { pinCheck: () => Promise.resolve(evaluation) });
      const { seen, beforeSend } = hooked();
      await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'upstream_changed' });
      expect(adapter.calls).toEqual([]);
      expect(seen.calls).toBe(0);
    }
  });

  it('CONN-4 the fresh pin check lists the tools with the configuration of this call (verifyPinNow)', async () => {
    const listed: string[] = [];
    const changed: ToolLister = (connection) => {
      listed.push(connection.id);
      return Promise.resolve(listOf({ ...SEND, description: 'now deletes everything' }));
    };
    const { adapter, caller } = await setup('tools.send', { pinCheck: (id) => verifyPinNow(changed, CONFIG, id) });
    await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'upstream_changed' });
    expect(listed).toEqual(['tools']);
    expect(adapter.calls).toEqual([]);
  });

  it('an unverified pin is not_sent/upstream_unavailable', async () => {
    const cases: { name: string; pinCheck?: OpaqueCallerDeps['pinCheck'] }[] = [
      { name: 'unverified', pinCheck: () => Promise.resolve({ state: 'unverified', liveHash: null }) },
      { name: 'schema_invalid', pinCheck: () => Promise.resolve({ state: 'schema_invalid', liveHash: PIN }) },
      { name: 'no evaluation', pinCheck: () => Promise.resolve(undefined) },
      // F8/F20: no tool lister wired → fail closed.
      { name: 'no pin check' },
    ];
    for (const c of cases) {
      const adapter = new FakeWriteAdapter();
      const caller = createOpaqueCaller({
        configuration: CONFIG,
        vault: new MemoryVault(),
        adapter,
        operationId: 'tools.send',
        correlationId: 'corr-o',
        ...(c.pinCheck === undefined ? {} : { pinCheck: c.pinCheck }),
      });
      const { seen, beforeSend } = hooked();
      await expect(caller?.call({ args: ARGS, idempotencyKey: KEY, beforeSend }), c.name).resolves.toEqual({ kind: 'not_sent', code: 'upstream_unavailable' });
      expect(adapter.calls, c.name).toEqual([]);
      expect(seen.calls, c.name).toBe(0);
    }
  });

  it('SEC-2 an unusable credential is not_sent/credential_unusable', async () => {
    for (const operationId of ['shop.plain', 'tools.send']) {
      const { adapter, caller, pinChecks } = await setup(operationId, {}, 'telepathy');
      const { seen, beforeSend } = hooked();
      await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'credential_unusable' });
      expect(adapter.calls).toEqual([]);
      expect(pinChecks).toEqual([]);
      expect(seen.calls).toBe(0);
    }
  });

  it('SEC-2 a connection without a stored credential reaches the adapter without one', async () => {
    const adapter = new FakeWriteAdapter({ result: 'not_sent', code: 'credential_missing', durationMs: 0 });
    const caller = createOpaqueCaller({ configuration: CONFIG, vault: new MemoryVault(), adapter, operationId: 'shop.plain', correlationId: 'c' });
    await expect(caller?.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'credential_missing' });
    expect(adapter.calls[0]).not.toHaveProperty('credential');
  });

  it('not_sent/mapping maps to upstream_rejected', async () => {
    // F9: definite pre-send refusals read as rejected, transient ones as unavailable; credential and egress codes stay.
    const expected: [WriteErrorCode | undefined, OpaqueNotSentCode][] = [
      ['mapping', 'upstream_rejected'],
      ['rejected', 'upstream_rejected'],
      ['credential_missing', 'credential_missing'],
      ['credential_unusable', 'credential_unusable'],
      ['egress_denied', 'egress_denied'],
      ['busy', 'upstream_unavailable'],
      ['timeout', 'upstream_unavailable'],
      ['network', 'upstream_unavailable'],
      ['http_status', 'upstream_unavailable'],
      ['upstream_error', 'upstream_unavailable'],
      ['invalid_response', 'upstream_unavailable'],
      [undefined, 'upstream_unavailable'],
    ];
    const { adapter, caller } = await setup('shop.plain');
    for (const [code, mapped] of expected) {
      adapter.outcome = { result: 'not_sent', ...(code === undefined ? {} : { code }), durationMs: 1 };
      await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend }), String(code)).resolves.toEqual({
        kind: 'not_sent',
        code: mapped,
      });
    }
  });

  it('EXE-4 accepted, refused and unknown pass through without upstream codes', async () => {
    const { adapter, caller } = await setup('tools.send');
    for (const outcome of [
      { result: 'accepted', status: 201, durationMs: 1 },
      { result: 'refused', code: 'rejected', status: 422, durationMs: 1 },
      { result: 'unknown', code: 'timeout', durationMs: 1 },
    ] satisfies CallOutcome[]) {
      adapter.outcome = outcome;
      await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend })).resolves.toEqual({ kind: outcome.result });
    }
  });

  it('EXE-4 a throwing beforeSend propagates unchanged and nothing is sent', async () => {
    for (const operationId of ['shop.keyed', 'tools.send']) {
      const { adapter, caller } = await setup(operationId);
      const fenced = new Error('BatchFenced');
      await expect(caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: () => Promise.reject(fenced) })).rejects.toBe(fenced);
      expect(adapter.sent).toBe(0);
    }
  });

  it('EXE-4 creating the caller has no side effects (callerFor contract)', () => {
    const adapter = new FakeWriteAdapter();
    const vault = new MemoryVault();
    let pinChecks = 0;
    const caller = createOpaqueCaller({
      configuration: CONFIG,
      vault,
      adapter,
      operationId: 'tools.send',
      correlationId: 'c',
      pinCheck: () => Promise.resolve(void (pinChecks += 1)),
      log: () => {
        throw new Error('no log at creation');
      },
    });
    expect(caller).toBeDefined();
    expect(adapter.calls).toEqual([]);
    expect(vault.handles).toBe(0);
    expect(pinChecks).toBe(0);
  });

  it('SEC-3 the log record has no arguments', async () => {
    const http = await setup('shop.keyed');
    http.adapter.outcome = { result: 'refused', code: 'rejected', status: 409, durationMs: 9 };
    await http.caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend });
    expect(http.lines).toEqual([
      { correlationId: 'corr-o', operation: 'shop.keyed', connection: 'shop', method: 'POST', status: 409, durationMs: 9, errorCode: 'rejected' },
    ]);

    const mcp = await setup('tools.send');
    await mcp.caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend });
    expect(mcp.lines).toEqual([{ correlationId: 'corr-o', operation: 'tools.send', connection: 'tools', method: 'tools/call', status: 200, durationMs: 7 }]);

    const refused = await setup('tools.send', { pinCheck: () => Promise.resolve({ state: 'changed', liveHash: 'x' }) });
    await refused.caller.call({ args: ARGS, idempotencyKey: KEY, beforeSend: hooked().beforeSend });
    expect(refused.lines).toEqual([{ correlationId: 'corr-o', operation: 'tools.send', connection: 'tools', method: 'tools/call', durationMs: 0, errorCode: 'upstream_changed' }]);

    const text = JSON.stringify([http.lines, mcp.lines, refused.lines]);
    expect(text).not.toContain(ARG_VALUE);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY);
  });

  it('undefined for a read operation or a bulk binding', () => {
    const base = { configuration: CONFIG, vault: new MemoryVault(), adapter: new FakeWriteAdapter(), correlationId: 'c' };
    expect(createOpaqueCaller({ ...base, operationId: 'shop.get' })).toBeUndefined();
    expect(createOpaqueCaller({ ...base, operationId: 'shop.bulk' })).toBeUndefined();
    expect(createOpaqueCaller({ ...base, operationId: 'unknown.op' })).toBeUndefined();
  });
});

type CodeCallInput = Parameters<CodeAdapter['codeCall']>[0];

/** A write adapter that also runs code calls; `events` records the order of beforeSend and codeCall. */
class FakeCodeCallAdapter extends FakeWriteAdapter implements Pick<CodeAdapter, 'codeCall'> {
  readonly codeCalls: CodeCallInput[] = [];
  constructor(
    readonly events: string[],
    public result: CodeCallResult = { ok: true, durationMs: 8 },
  ) {
    super();
  }
  codeCall(input: CodeCallInput): Promise<CodeCallResult> {
    this.events.push('codeCall');
    this.codeCalls.push(input);
    return Promise.resolve(this.result);
  }
}

const FIXTURE = await loadCodeFixture();

describe('OPS-5 EXE-4 createOpaqueCaller for a code binding', () => {
  const PING_ARGS = { message: 'a-distinctive-ping-message' };

  async function setupCode(overrides: Partial<OpaqueCallerDeps> = {}, scheme = 'bearer') {
    const events: string[] = [];
    const adapter = new FakeCodeCallAdapter(events);
    const vault = new MemoryVault();
    await vault.put({ ref: 'items-token', scheme, secret: { token: SECRET }, actor: 'test' });
    const lines: UpstreamCallLog[] = [];
    const caller = createOpaqueCaller({ configuration: FIXTURE, vault, adapter, operationId: 'fixture.ping', correlationId: 'corr-c', log: (l) => lines.push(l), ...overrides });
    if (caller === undefined) throw new Error('expected an opaque caller for fixture.ping');
    const beforeSend = (): Promise<void> => Promise.resolve(void events.push('beforeSend'));
    return { events, adapter, vault, lines, caller, beforeSend };
  }

  it('OPS-5 EXE-4 a code call is sent once; a definite refusal and an indefinite failure map to plan 2 outcomes', async () => {
    const s = await setupCode();
    expect(s.caller.idempotencyHeader).toBeUndefined();
    await expect(s.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: s.beforeSend })).resolves.toEqual({ kind: 'accepted' });
    // The submission is recorded (beforeSend) before the code module runs (EXE-4).
    expect(s.events).toEqual(['beforeSend', 'codeCall']);
    const binding = FIXTURE.bindings.get('fixture.ping');
    if (binding?.kind !== 'code') throw new Error('fixture.ping has no code binding');
    const [input] = s.adapter.codeCalls;
    expect(input?.name).toBe(binding.name);
    expect(input?.operation).toBe(FIXTURE.codeOperations.get('fixture.ping'));
    expect(input?.args).toBe(PING_ARGS);
    expect(input?.connection).toBe(FIXTURE.connectionSettings.get('items'));
    expect(await input?.credential?.open()).toEqual({ token: SECRET });
    expect(input).not.toHaveProperty('idempotencyKey');
    expect(s.adapter.calls).toEqual([]);

    s.adapter.result = { ok: false, definite: true, code: 'rejected', durationMs: 3 };
    await expect(s.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: s.beforeSend })).resolves.toEqual({ kind: 'refused' });
    s.adapter.result = { ok: false, definite: false, code: 'timeout', durationMs: 300_000 };
    await expect(s.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: s.beforeSend })).resolves.toEqual({ kind: 'unknown' });
    expect(s.adapter.codeCalls).toHaveLength(3);

    // SEC-3: identifiers, method CODE, timing and the fixed code only.
    expect(s.lines).toEqual([
      { correlationId: 'corr-c', operation: 'fixture.ping', connection: 'items', method: 'CODE', durationMs: 8 },
      { correlationId: 'corr-c', operation: 'fixture.ping', connection: 'items', method: 'CODE', durationMs: 3, errorCode: 'rejected' },
      { correlationId: 'corr-c', operation: 'fixture.ping', connection: 'items', method: 'CODE', durationMs: 300_000, errorCode: 'timeout' },
    ]);
    const text = JSON.stringify(s.lines);
    expect(text).not.toContain(PING_ARGS.message);
    expect(text).not.toContain(SECRET);
  });

  it('OPS-5 EXE-4 a throwing beforeSend propagates and never reaches codeCall', async () => {
    const s = await setupCode();
    const fenced = new Error('BatchFenced');
    await expect(s.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: () => Promise.reject(fenced) })).rejects.toBe(fenced);
    expect(s.adapter.codeCalls).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('OPS-5 SEC-2 pre-flight refusals are not_sent and never call beforeSend or the code module', async () => {
    const unusable = await setupCode({}, 'no-such-scheme');
    await expect(unusable.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: unusable.beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'credential_unusable' });
    expect(unusable.events).toEqual([]);
    expect(unusable.lines).toEqual([{ correlationId: 'corr-c', operation: 'fixture.ping', connection: 'items', method: 'CODE', durationMs: 0, errorCode: 'credential_unusable' }]);

    // A module operation that is not a call (or none) is refused as upstream_rejected.
    const getMany = FIXTURE.codeOperations.get('fixture.get_many');
    if (getMany === undefined) throw new Error('fixture.get_many has no code operation');
    for (const codeOperations of [new Map([...FIXTURE.codeOperations, ['fixture.ping', getMany]]), new Map()]) {
      const wrong = await setupCode({ configuration: { ...FIXTURE, codeOperations } });
      await expect(wrong.caller.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: wrong.beforeSend })).resolves.toEqual({ kind: 'not_sent', code: 'upstream_rejected' });
      expect(wrong.events).toEqual([]);
    }

    // An adapter that cannot run code calls is upstream_unavailable.
    const events: string[] = [];
    const vault = new MemoryVault();
    const caller = createOpaqueCaller({ configuration: FIXTURE, vault, adapter: new FakeWriteAdapter(), operationId: 'fixture.ping', correlationId: 'corr-c' });
    await expect(
      caller?.call({ args: PING_ARGS, idempotencyKey: KEY, beforeSend: () => Promise.resolve(void events.push('beforeSend')) }),
    ).resolves.toEqual({ kind: 'not_sent', code: 'upstream_unavailable' });
    expect(events).toEqual([]);
  });

  it('OPS-5 undefined for a code write or read operation (not opaque)', () => {
    const base = { configuration: FIXTURE, vault: new MemoryVault(), adapter: new FakeCodeCallAdapter([]), correlationId: 'c' };
    expect(createOpaqueCaller({ ...base, operationId: 'fixture.set_tags' })).toBeUndefined();
    expect(createOpaqueCaller({ ...base, operationId: 'fixture.get_many' })).toBeUndefined();
  });
});
