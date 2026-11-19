import { describe, expect, it } from 'vitest';
import type { Caller } from '../caller.js';
import type { EvaluationRequest, PolicyDecision } from '../policy-engine.js';
import type { ManifestDefinition, OperationDefinition, RollbackStrategy } from '../policy-model.js';
import type { ChangeSetRecord, ChangeSetStatus, RollbackRequest } from './model.js';
import {
  changesetRollbackBatchEvent,
  ROLLBACK_REQUEST_MARGIN_MS,
  rollbackEligibility,
  type RollbackEligibilityDeps,
  rollbackFromFinished,
  rollbackOutcome,
  rollbackWindowOpen,
  type RollbackReads,
  rollbackRequestEvents,
  rollbackTerminal,
  rollbackWindowEnd,
} from './rollback.js';

const ID = '7d0f8c2e-4b1a-4c3d-9e8f-0a1b2c3d4e5f';
const HASH = `sha256:${'a'.repeat(64)}`;
const UNTIL = new Date('2026-11-20T12:00:00.000Z');
const OP = 'catalog.update_content';

const manifest = (rollback: RollbackStrategy): ManifestDefinition => ({
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: {} },
  batchSize: 10,
  maxTargets: 100,
  rollback,
});

function operation(rollback: RollbackStrategy | null = { strategy: 'replay_previous_state' }): OperationDefinition {
  return {
    id: OP,
    toolName: 'catalog_update_content',
    source: 'config',
    connection: 'magento',
    risk: 'write',
    description: 'Update content',
    inputSchema: { type: 'object' },
    ...(rollback === null ? {} : { manifest: manifest(rollback) }),
  };
}

const executionRequest = { actor: 'alice', groups: [], correlationId: 'k-exec', startedAt: new Date(0) };

/** A completed, executed change-set; a key patched to `undefined` is left out (exactOptionalPropertyTypes). */
function record(patch: { [K in keyof ChangeSetRecord]?: ChangeSetRecord[K] | undefined } = {}): ChangeSetRecord {
  const row = {
    id: ID,
    operation: OP,
    connection: 'magento',
    requester: 'alice',
    args: { skus: ['SKU-SECRET-1'], changes: { name: 'ARG-SECRET' } },
    hash: HASH,
    status: 'completed',
    stats: { total: 4, included: 4, excluded: {}, written: 4, failed: 0, skipped: 0 },
    configHash: 'cfg',
    correlationId: 'k-prep',
    createdAt: new Date(0),
    expiresAt: new Date(0),
    approvalRound: 0,
    executionRequest,
    rollbackUntil: UNTIL,
    ...patch,
  };
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as unknown as ChangeSetRecord;
}

class FakeReads implements RollbackReads {
  readonly gets: string[] = [];
  constructor(
    private readonly row: ChangeSetRecord | undefined,
    private readonly count = 4,
  ) {}
  get(changesetId: string): Promise<ChangeSetRecord | undefined> {
    this.gets.push(changesetId);
    return Promise.resolve(this.row?.id === changesetId ? this.row : undefined);
  }
  rollbackableCount(): Promise<number> {
    return Promise.resolve(this.count);
  }
}

class FakeEngine {
  readonly seen: EvaluationRequest[] = [];
  constructor(private readonly effect: 'allow' | 'deny' = 'allow') {}
  evaluate(request: EvaluationRequest): PolicyDecision {
    this.seen.push(request);
    return { effect: this.effect, rule: 'test', roles: [] };
  }
}

const alice: Caller = { subject: 'alice', groups: ['editors'] };
const EARLY = new Date(UNTIL.getTime() - 61_000);

function deps(
  row: ChangeSetRecord | undefined,
  opts: { count?: number; engine?: FakeEngine; operations?: readonly OperationDefinition[]; now?: Date } = {},
): RollbackEligibilityDeps & { repository: FakeReads } {
  const now = opts.now ?? EARLY;
  return {
    repository: new FakeReads(row, opts.count ?? 4),
    engine: opts.engine ?? new FakeEngine(),
    operations: opts.operations ?? [operation()],
    now: () => now,
  };
}

const ask = (d: RollbackEligibilityDeps, extra: { changesetId?: string; caller?: Caller; hash?: string } = {}) =>
  rollbackEligibility(d, { changesetId: ID, caller: alice, hash: HASH, ...extra });

const notRollbackable = (reason: string) => ({ ok: false, refusal: 'not_rollbackable', reason });

describe('EXE-8 rollback eligibility', () => {
  it('EXE-8 SEC-1 refusals come in the fixed order', async () => {
    // not_found: unknown, not a UUID (no store access), foreign caller.
    expect(await ask(deps(undefined))).toEqual({ ok: false, refusal: 'not_found' });
    const nonUuid = deps(record());
    expect(await ask(nonUuid, { changesetId: 'not-a-uuid' })).toEqual({ ok: false, refusal: 'not_found' });
    expect(nonUuid.repository.gets).toEqual([]);
    expect(await ask(deps(record()), { caller: { subject: 'mallory', groups: ['editors'] } })).toEqual({
      ok: false,
      refusal: 'not_found',
    });

    // hash_mismatch before any not_rollbackable reason, even with the window closed.
    expect(await ask(deps(record({ rollbackUntil: undefined })), { hash: `sha256:${'b'.repeat(64)}` })).toEqual({
      ok: false,
      refusal: 'hash_mismatch',
    });

    // already_rolled_back.
    for (const status of ['rolling_back', 'rolled_back'] as const) {
      expect(await ask(deps(record({ status }))), status).toEqual(notRollbackable('already_rolled_back'));
    }
    const rollbackRequest: RollbackRequest = { actor: 'alice', correlationId: 'k-rb', requestedAt: new Date(0) };
    expect(await ask(deps(record({ status: 'failed', rollbackRequest })))).toEqual(
      notRollbackable('already_rolled_back'),
    );

    // not_finished.
    for (const status of ['prepared', 'executing', 'expired'] as const) {
      expect(await ask(deps(record({ status }))), status).toEqual(notRollbackable('not_finished'));
    }
    expect(await ask(deps(record({ status: 'cancelled', executionRequest: undefined })))).toEqual(
      notRollbackable('not_finished'),
    );

    // strategy_none: strategy none, operation no longer configured, operation without manifest.
    expect(await ask(deps(record(), { operations: [operation({ strategy: 'none' })] }))).toEqual(
      notRollbackable('strategy_none'),
    );
    expect(await ask(deps(record(), { operations: [] }))).toEqual(notRollbackable('strategy_none'));
    expect(await ask(deps(record(), { operations: [operation(null)] }))).toEqual(
      notRollbackable('strategy_none'),
    );

    // window_closed: no window, inside the 60 s margin.
    expect(await ask(deps(record({ rollbackUntil: undefined })))).toEqual(notRollbackable('window_closed'));
    expect(await ask(deps(record(), { now: new Date(UNTIL.getTime() - 60_000) }))).toEqual(
      notRollbackable('window_closed'),
    );
    expect(await ask(deps(record(), { now: new Date(UNTIL.getTime() - 59_000) }))).toEqual(
      notRollbackable('window_closed'),
    );

    // nothing_written.
    expect(await ask(deps(record(), { count: 0 }))).toEqual(notRollbackable('nothing_written'));

    // policy_denied last.
    expect(await ask(deps(record(), { engine: new FakeEngine('deny') }))).toEqual({
      ok: false,
      refusal: 'policy_denied',
    });
    expect(ROLLBACK_REQUEST_MARGIN_MS).toBe(60_000);
  });

  it('EXE-8 SEC-1 the order holds when two adjacent rules fail at once', async () => {
    const wrongHash = `sha256:${'b'.repeat(64)}`;
    const none = [operation({ strategy: 'none' })];
    expect(await ask(deps(record()), { caller: { subject: 'mallory', groups: [] }, hash: wrongHash })).toEqual({
      ok: false,
      refusal: 'not_found',
    });
    expect(await ask(deps(record({ status: 'prepared' }), { operations: none }))).toEqual(notRollbackable('not_finished'));
    expect(await ask(deps(record({ rollbackUntil: undefined }), { operations: none }))).toEqual(
      notRollbackable('strategy_none'),
    );
    expect(await ask(deps(record(), { count: 0, now: new Date(UNTIL.getTime() - 60_000) }))).toEqual(
      notRollbackable('window_closed'),
    );
    expect(await ask(deps(record(), { count: 0, engine: new FakeEngine('deny') }))).toEqual(
      notRollbackable('nothing_written'),
    );
  });

  it('EXE-8 an invalid window end or count fails closed', async () => {
    expect(await ask(deps(record({ rollbackUntil: new Date(Number.NaN) })))).toEqual(notRollbackable('window_closed'));
    expect(await ask(deps(record(), { now: new Date(Number.NaN) }))).toEqual(notRollbackable('window_closed'));
    expect(await ask(deps(record(), { count: Number.NaN }))).toEqual(notRollbackable('nothing_written'));
  });

  it('EXE-8 an eligible change-set answers the count and the window end', async () => {
    expect(await ask(deps(record()))).toEqual({ ok: true, count: 4, until: UNTIL });
    expect(
      await rollbackEligibility(deps(record({ status: 'failed' })), { changesetId: ID, caller: alice }),
    ).toEqual({ ok: true, count: 4, until: UNTIL });
    expect(
      await rollbackEligibility(deps(record({ status: 'cancelled' })), { changesetId: ID, caller: alice }),
    ).toEqual({ ok: true, count: 4, until: UNTIL });
  });

  it('POL-6 the policy is evaluated for the caller with the stored arguments', async () => {
    const engine = new FakeEngine();
    const row = record();
    await ask(deps(row, { engine }));
    expect(engine.seen).toEqual([{ caller: alice, operationId: OP, args: row.args }]);
  });

  it('EXE-8 rollbackWindowEnd opens a window only for an executed change-set with written items', () => {
    const now = new Date('2026-11-19T00:00:00.000Z');
    const base = { changeset: record({ rollbackUntil: undefined }), operation: operation(), rollbackable: 3, hours: 168, now };
    expect(rollbackWindowEnd(base)).toEqual(new Date(now.getTime() + 168 * 3_600_000));
    expect(rollbackWindowEnd({ ...base, hours: 15 / 3600 })).toEqual(new Date(now.getTime() + 15_000));
    expect(rollbackWindowEnd({ ...base, changeset: record({ status: 'failed' }) })).toEqual(
      new Date(now.getTime() + 168 * 3_600_000),
    );
    expect(rollbackWindowEnd({ ...base, hours: 0 })).toBeUndefined();
    expect(rollbackWindowEnd({ ...base, operation: operation({ strategy: 'none' }) })).toBeUndefined();
    expect(rollbackWindowEnd({ ...base, operation: undefined })).toBeUndefined();
    expect(rollbackWindowEnd({ ...base, rollbackable: 0 })).toBeUndefined();
    expect(
      rollbackWindowEnd({ ...base, changeset: record({ status: 'cancelled', executionRequest: undefined }) }),
    ).toBeUndefined();
    expect(
      rollbackWindowEnd({
        ...base,
        changeset: record({ rollbackRequest: { actor: 'alice', correlationId: 'k', requestedAt: now } }),
      }),
    ).toBeUndefined();
    for (const status of ['executing', 'rolling_back', 'rolled_back'] as ChangeSetStatus[]) {
      expect(rollbackWindowEnd({ ...base, changeset: record({ status }) }), status).toBeUndefined();
    }
  });

  it('EXE-8 rollbackTerminal maps every outcome', () => {
    expect(rollbackTerminal('done')).toEqual({ status: 'rolled_back' });
    expect(rollbackTerminal('writer_error')).toEqual({ status: 'failed', errorCode: 'rollback_writer_error' });
    expect(rollbackTerminal('executor_error')).toEqual({ status: 'failed', errorCode: 'rollback_executor_error' });
    expect(rollbackTerminal('hash_mismatch')).toEqual({ status: 'failed', errorCode: 'rollback_hash_mismatch' });
  });

  it('AUD-1 SEC-3 the request writes the transition and one changeset.rollback row without target ids or hash', () => {
    let n = 0;
    const changeset = record({ status: 'completed_with_errors' });
    const request: RollbackRequest = {
      actor: 'alice',
      clientId: 'chat-client',
      correlationId: 'k-rb',
      requestedAt: new Date(0),
    };
    const events = rollbackRequestEvents({ newId: () => `e-${String(++n)}`, changeset, request, channel: 'page', count: 4 });
    expect(events).toEqual([
      {
        id: 'e-1',
        actor: 'alice',
        clientId: 'chat-client',
        action: 'changeset.transition',
        subject: OP,
        outcome: 'ok',
        correlationId: 'k-rb',
        changesetId: ID,
        details: { from: 'completed_with_errors', to: 'rolling_back', operation: OP },
      },
      {
        id: 'e-2',
        actor: 'alice',
        clientId: 'chat-client',
        action: 'changeset.rollback',
        subject: OP,
        outcome: 'ok',
        correlationId: 'k-rb',
        changesetId: ID,
        details: { channel: 'page', count: 4 },
      },
    ]);
    const text = JSON.stringify(events);
    for (const secret of ['SKU-SECRET-1', 'ARG-SECRET', HASH]) expect(text).not.toContain(secret);

    const noClient = rollbackRequestEvents({
      newId: () => 'x',
      changeset,
      request: { actor: 'alice', correlationId: 'k', requestedAt: new Date(0) },
      channel: 'page',
      count: 1,
    });
    for (const e of noClient) expect('clientId' in e).toBe(false);

    expect(
      changesetRollbackBatchEvent({
        id: 'b-1',
        changeset,
        batchNo: 2,
        counts: { restored: 3, skipped: 1, failed: 0 },
        correlationId: 'k-rb',
      }),
    ).toEqual({
      id: 'b-1',
      actor: 'system',
      action: 'changeset.batch',
      subject: OP,
      outcome: 'ok',
      correlationId: 'k-rb',
      changesetId: ID,
      details: { phase: 'rollback', batchNo: 2, restored: 3, skipped: 1, failed: 0 },
    });
  });
});

describe('EXE-8 shared rollback predicates', () => {
  it('EXE-8 rollbackFromFinished admits finished runs only, cancelled/failed only once executed', () => {
    const started = { actor: 'a', groups: [], correlationId: 'c', startedAt: UNTIL };
    for (const status of ['completed', 'completed_with_errors'] as const) {
      expect(rollbackFromFinished({ status })).toBe(true);
    }
    for (const status of ['cancelled', 'failed'] as const) {
      expect(rollbackFromFinished({ status })).toBe(false);
      expect(rollbackFromFinished({ status, executionRequest: started })).toBe(true);
    }
    for (const status of ['preparing', 'prepared', 'pending_approval', 'approved', 'executing', 'rejected', 'expired', 'rolling_back', 'rolled_back'] as const) {
      expect(rollbackFromFinished({ status, executionRequest: started })).toBe(false);
    }
  });

  it('EXE-8 rollbackWindowOpen is open strictly before until minus the margin and fails closed', () => {
    const m = ROLLBACK_REQUEST_MARGIN_MS;
    expect(rollbackWindowOpen(UNTIL, new Date(UNTIL.getTime() - m - 1), m)).toBe(true);
    expect(rollbackWindowOpen(UNTIL, new Date(UNTIL.getTime() - m), m)).toBe(false);
    expect(rollbackWindowOpen(undefined, new Date(0), m)).toBe(false);
    expect(rollbackWindowOpen(new Date(Number.NaN), new Date(0), m)).toBe(false);
    expect(rollbackWindowOpen(UNTIL, new Date(Number.NaN), m)).toBe(false);
    expect(rollbackWindowOpen(UNTIL, new Date(0), Number.NaN)).toBe(false);
  });
});

describe('EXE-8 rollbackOutcome', () => {
  it('EXE-8 a written outcome is restored with its error kept; skipped and failed stay', () => {
    expect(rollbackOutcome({ targetId: 'a', status: 'written' })).toEqual({ targetId: 'a', status: 'restored' });
    expect(rollbackOutcome({ targetId: 'b', status: 'written', error: 'already_restored' })).toEqual({
      targetId: 'b',
      status: 'restored',
      error: 'already_restored',
    });
    expect(rollbackOutcome({ targetId: 'c', status: 'skipped', error: 'drift' })).toEqual({ targetId: 'c', status: 'skipped', error: 'drift' });
    expect(rollbackOutcome({ targetId: 'd', status: 'failed' })).toEqual({ targetId: 'd', status: 'failed' });
  });
});
