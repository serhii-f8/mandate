// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import {
  ExecutorUnavailable,
  type Caller,
  type ChangeSetExecutor,
  type ExecutionProgress,
  type StartOutcome,
  type StartRequest,
  type TaskRecord,
} from '@mandate/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryTaskRepository } from '@mandate/testing';
import { ApprovalService } from '../approvals/approval-service.js';
import { AUDIT_UNAVAILABLE, type AuditDetails } from './audited-tool.js';
import { submitForApprovalTool } from './submit-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import { snapshotOf, type Snapshot } from './tool-pipeline.js';

function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function sources(scope: string) {
  return {
    'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
    'operations.yaml': `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: catalog.update_content
    connection: magento
    risk: write
    description: Update content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products
        ids_arg: skus
        args: { brand: { arg: brand } }
      rollback: { strategy: replay_previous_state }
  - id: catalog.retire_content
    connection: magento
    risk: destructive
    description: Retire content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products
        ids_arg: skus
        args: { brand: { arg: brand } }
      rollback: { strategy: replay_previous_state }
`,
    'roles.yaml': `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.update_content, id: own-brands, scope: { brand: [${scope}] } }
      - { operation: catalog.retire_content, id: retire, scope: { brand: [${scope}] } }
    limits: { records_per_operation: 50, records_per_day: 500, concurrent_executions: 2 }
    approval: { required: never, steps: [{ role: other_role }] }
  - id: other_role
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { steps: [{ role: content_manager }] }
  - id: always_role
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: always, steps: [{ role: content_manager }] }
  - id: threshold_role
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: above_threshold, record_threshold: 1, steps: [{ role: content_manager }] }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: other, roles: [other_role] }
  - { group: always, roles: [always_role] }
  - { group: threshold, roles: [threshold_role] }
`,
  };
}

async function configuration(scope: string): Promise<LoadedConfiguration> {
  const loaded = await loadConfigurationSources(Object.entries(sources(scope)).map(([file, text]) => ({ file, text })));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.configuration;
}

const CURRENT = snapshotOf(await configuration('acme, globex'));
/** The grant no longer covers the stored brand `acme` (POL-6). */
const NARROWED = snapshotOf(await configuration('globex'));

const alice: Caller = { subject: 'alice', clientId: 'mandate-mcp', groups: ['content'] };
const bob: Caller = { subject: 'bob', groups: ['content'] };
const carol: Caller = { subject: 'carol', groups: ['other'] };
const ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');

type Answer = StartOutcome | 'unavailable';

class StubExecutor implements ChangeSetExecutor {
  readonly starts: StartRequest[] = [];
  answer: Answer = { ok: true };

  start(req: StartRequest): Promise<StartOutcome> {
    this.starts.push(req);
    return this.answer === 'unavailable' ? Promise.reject(new ExecutorUnavailable()) : Promise.resolve(this.answer);
  }

  cancel(): ReturnType<ChangeSetExecutor['cancel']> {
    return Promise.reject(new Error('not used'));
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  requestRollback(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  progress(): Promise<ExecutionProgress | undefined> {
    return Promise.reject(new Error('not used'));
  }
}

class RecordingTasks extends InMemoryTaskRepository {
  readonly created: TaskRecord[] = [];
  override create(task: TaskRecord): Promise<void> {
    this.created.push(task);
    return super.create(task);
  }
}

type Stage = 'preparing' | 'prepared' | 'pending_approval' | 'approved' | 'executing';

/** The submission an approval round stores (POL-6): who asked, under which role. */
const submissionOf = (actor: string, groups: readonly string[]) => ({
  actor,
  groups,
  correlationId: 'c-sub',
  at: NOW,
  role: 'always_role',
  rule: 'role:always_role/grant:all',
});

async function setup(
  options: {
    requester?: string;
    requesterGroups?: readonly string[];
    stage?: Stage;
    expiresAt?: Date;
    items?: readonly string[];
    operation?: string;
  } = {},
) {
  const audit = new InMemoryAuditLog();
  // One log for the tool's rows and the repository's transaction rows.
  const repository = new InMemoryChangeSetRepository(audit);
  const tasks = new RecordingTasks();
  const executor = new StubExecutor();
  const event = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: ID,
      operation: options.operation ?? 'catalog.update_content',
      connection: 'magento',
      requester: options.requester ?? 'alice',
      args: { brand: 'acme', skus: ['a', 'b', 'c'], changes: { name: 'New' } },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: options.expiresAt ?? new Date('2026-11-18T10:00:00.000Z'),
    },
    event,
  );
  const stage = options.stage ?? 'prepared';
  const items = options.items ?? ['a', 'b', 'c'];
  if (stage !== 'preparing') {
    await repository.appendItems(ID, items.map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
    await repository.completePreparation(
      ID,
      { status: 'prepared', hashVersion: 1, hash: HASH, stats: { total: items.length, included: items.length, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
      { ...event, id: 'a1' },
    );
  }
  if (stage === 'pending_approval' || stage === 'approved') {
    const submitted = await repository.submitForApproval({
      changesetId: ID,
      expectedHash: HASH,
      submission: submissionOf(options.requester ?? 'alice', options.requesterGroups ?? ['content']),
      plan: { reason: 'role_always', steps: ['content_manager'], widget: false, included: items.length },
      audit: { transition: { ...event, id: 'a3' }, requested: { ...event, id: 'a4', action: 'approval.requested' as const } },
      notifications: [],
    });
    if (!submitted.ok) throw new Error(submitted.reason);
  }
  if (stage === 'approved') {
    const decided = await repository.recordDecision({
      changesetId: ID,
      round: 1,
      step: 1,
      record: {
        id: 'ap-1',
        changesetId: ID,
        round: 1,
        step: 1,
        role: 'content_manager',
        approver: 'dave',
        decision: 'approved',
        hash: HASH,
        itemCount: items.length,
        channel: 'page',
        correlationId: 'c-dec',
        ts: NOW,
      },
      next: { kind: 'approved' },
      audit: [{ ...event, id: 'a5', action: 'approval.decision' as const }],
      notifications: [],
    });
    if (!decided.ok) throw new Error(decided.reason);
  }
  if (stage === 'executing') {
    const moved = await repository.transition(ID, ['prepared'], 'executing', { ...event, id: 'a2' });
    if (moved === undefined) throw new Error('transition failed');
  }
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const now = () => NOW;
  const tool = submitForApprovalTool({
    repository,
    tasks,
    executor,
    audit,
    newId,
    now,
    approvals: new ApprovalService({ repository, executor, audit, newId, now }),
    publicUrl: new URL('http://localhost:8400'),
  });
  const reported: AuditDetails[] = [];
  const ctx = (caller: Caller, opts: { tasks?: boolean; snapshot?: Snapshot } = {}) => ({
    caller,
    snapshot: opts.snapshot ?? CURRENT,
    correlationId: 'corr-8',
    tasks: opts.tasks ?? false,
    report: (d: AuditDetails) => {
      reported.push(d);
    },
  });
  const reportedAll = (): AuditDetails => Object.assign({}, ...reported) as AuditDetails;
  return { repository, tasks, audit, executor, tool, ctx, reportedAll };
}

const args = (id = ID, hash = HASH) => ({ changeset_id: id, hash });

describe('MCP-8 POL-6 POL-5 POL-4 submit_for_approval', () => {
  it('MCP-8 publishes a write tool with a strict input schema', async () => {
    const { tool } = await setup();
    expect(tool.name).toBe('submit_for_approval');
    expect(tool.readOnlyHint).toBe(false);
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { changeset_id: { type: 'string', format: 'uuid' }, hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
      required: ['changeset_id', 'hash'],
      additionalProperties: false,
    });
    expect(tool.validate(args()).ok).toBe(true);
    expect(tool.validate({ changeset_id: ID }).ok).toBe(false);
    expect(tool.validate(args(ID, 'sha256:xyz')).ok).toBe(false);
    expect(tool.validate({ ...args(), extra: 1 }).ok).toBe(false);
  });

  it('MCP-8 unknown id answers not found', async () => {
    const { tool, ctx, executor } = await setup();
    const result = plain(await tool.handler(args(UNKNOWN), ctx(alice)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${UNKNOWN} was not found.`);
    expect(executor.starts).toEqual([]);
  });

  it('MCP-8 a foreign change-set answers the same text', async () => {
    const { tool, ctx, executor } = await setup();
    const result = plain(await tool.handler(args(), ctx(bob)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} was not found.`);
    expect(executor.starts).toEqual([]);
  });

  it('MCP-8 POL-8 an audit log that rejects answers the fixed text and never starts', async () => {
    const { tool, ctx, executor, audit } = await setup();
    audit.append = () => Promise.reject(new Error('audit down'));
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result).toEqual(AUDIT_UNAVAILABLE);
    expect(executor.starts).toEqual([]);
  });

  it('MCP-8 CS-6 an expired change-set answers the status text and never starts', async () => {
    const { tool, ctx, executor, tasks } = await setup({ expiresAt: new Date('2026-11-17T09:00:00.000Z') });
    const result = plain(await tool.handler(args(), ctx(alice, { tasks: true })));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} cannot be submitted in status expired.`);
    expect(executor.starts).toEqual([]);
    expect(tasks.created).toEqual([]);
  });

  it('MCP-8 wrong status names it', async () => {
    const { tool, ctx, executor } = await setup({ stage: 'preparing' });
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} cannot be submitted in status preparing.`);
    expect(executor.starts).toEqual([]);
  });

  it('MCP-8 MCP-7 a second submit while executing is refused without a second start or task', async () => {
    const { tool, ctx, executor, tasks } = await setup({ stage: 'executing' });
    const result = plain(await tool.handler(args(), ctx(alice, { tasks: true })));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} cannot be submitted in status executing.`);
    expect(executor.starts).toEqual([]);
    expect(tasks.created).toEqual([]);
  });

  it('POL-6 POL-8 a denied re-evaluation is audited and answered as a policy denial', async () => {
    const { tool, ctx, executor, audit } = await setup();
    const result = plain(await tool.handler(args(), ctx(alice, { snapshot: NARROWED })));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Denied by policy: /);
    const decisions = audit.events.filter((e) => e.action === 'policy.decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: 'deny', actor: 'alice', changesetId: ID, details: { operation: 'catalog.update_content' } });
    expect(executor.starts).toEqual([]);
  });

  it('POL-6 POL-8 an allowed re-evaluation is audited before the start', async () => {
    const { tool, ctx, audit } = await setup();
    await tool.handler(args(), ctx(alice));
    expect(audit.events.filter((e) => e.action === 'policy.decision')).toEqual([
      expect.objectContaining({ decision: 'allow', changesetId: ID, details: expect.objectContaining({ rule: 'role:content_manager/grant:own-brands' }) as unknown }),
    ]);
  });

  it('POL-5 a role without approval.required routes to approval by default', async () => {
    const { tool, ctx, executor, repository } = await setup({ requester: 'carol' });
    const result = plain(await tool.handler(args(), ctx(carol)));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: 'pending_approval' });
    expect((await repository.get(ID))?.approvalPlan).toMatchObject({ reason: 'default', steps: ['content_manager'] });
    expect(executor.starts).toEqual([]);
  });

  it('MCP-7 AUD-1 a failed task write still reports the change-set ID for the tool.call row', async () => {
    const { tool, ctx, tasks, reportedAll } = await setup();
    tasks.create = () => Promise.reject(new Error('task store down'));
    await expect(tool.handler(args(), ctx(alice, { tasks: true }))).rejects.toThrow('task store down');
    expect(reportedAll().changesetId).toBe(ID);
  });

  it('POL-4 start receives groups, clientId and the allowing role\'s limits', async () => {
    const { tool, ctx, executor } = await setup();
    await tool.handler(args(), ctx(alice));
    expect(executor.starts).toEqual([
      {
        changesetId: ID,
        expectedHash: HASH,
        actor: 'alice',
        correlationId: 'corr-8',
        groups: alice.groups,
        clientId: 'mandate-mcp',
        limits: { role: 'content_manager', recordsPerOperation: 50, recordsPerDay: 500, concurrentExecutions: 2 },
        submission: {
          actor: 'alice',
          groups: alice.groups,
          clientId: 'mandate-mcp',
          correlationId: 'corr-8',
          at: NOW,
          role: 'content_manager',
          rule: 'role:content_manager/grant:own-brands',
        },
      },
    ]);
  });

  const refusals: [StartOutcome, string, string][] = [
    [{ ok: false, reason: 'hash_mismatch' }, 'The change-set changed; review it again.', 'hash_mismatch'],
    [{ ok: false, reason: 'expired' }, `Change-set ${ID} has expired.`, 'expired'],
    [{ ok: false, reason: 'not_executable' }, `Change-set ${ID} cannot be executed in its current state.`, 'not_executable'],
    [{ ok: false, reason: 'not_found' }, `Change-set ${ID} was not found.`, 'not_found'],
    [
      { ok: false, reason: 'limit_exceeded', limit: 'records_per_day' },
      'Execution refused: limit records_per_day of role content_manager reached.',
      'limit_exceeded',
    ],
  ];
  for (const [outcome, expected, code] of refusals) {
    it(`MCP-8 POL-4 the refusal ${code} maps to a fixed text`, async () => {
      const { tool, ctx, executor, tasks, reportedAll } = await setup();
      executor.answer = outcome;
      const result = plain(await tool.handler(args(), ctx(alice, { tasks: true })));
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(expected);
      expect(reportedAll().errorCode).toBe(code);
      expect(tasks.created).toEqual([]);
    });
  }

  it('POL-4 POL-8 a limit refusal is not recorded a second time by the tool', async () => {
    const { tool, ctx, executor, audit } = await setup();
    executor.answer = { ok: false, reason: 'limit_exceeded', limit: 'records_per_day' };
    await tool.handler(args(), ctx(alice));
    // Only the re-evaluation's allow; the limit's deny row is the executor's start path (startEventFactory).
    expect(audit.events.filter((e) => e.action === 'policy.decision').map((e) => e.decision)).toEqual(['allow']);
  });

  it('MCP-8 an unreachable executor answers executor_unavailable', async () => {
    const { tool, ctx, executor, tasks, reportedAll } = await setup();
    executor.answer = 'unavailable';
    const result = plain(await tool.handler(args(), ctx(alice, { tasks: true })));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} could not be started: the execution service is unavailable.`);
    expect(reportedAll().errorCode).toBe('executor_unavailable');
    expect(tasks.created).toEqual([]);
  });

  it('MCP-8 MCP-1 started for a plain client', async () => {
    const { tool, ctx, tasks } = await setup();
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('Execution of 3 changes started. Call get_changeset with this ID to follow it.');
    expect(result.structuredContent).toEqual({ changesetId: ID, status: 'executing', total: 3 });
    expect(tasks.created).toEqual([]);
  });

  it('MCP-8 MCP-7 started for a declaring client returns an execute task', async () => {
    const { tool, ctx, tasks, reportedAll } = await setup();
    const answer = await tool.handler(args(), ctx(alice, { tasks: true }));
    expect(isTaskAnswer(answer)).toBe(true);
    expect(answer).toMatchObject({ resultType: 'task', status: 'working' });
    expect(tasks.created).toHaveLength(1);
    const task = tasks.created[0];
    expect(task).toMatchObject({ kind: 'execute', tool: 'submit_for_approval', owner: 'alice', clientId: 'mandate-mcp', changesetId: ID });
    expect(await tasks.findOwned(task?.taskId ?? '', 'alice')).toEqual(task);
    expect(isTaskAnswer(answer) ? answer.taskId : undefined).toBe(task?.taskId);
    expect(reportedAll().taskId).toBe(task?.taskId);
  });
});

const URL_OF = `http://localhost:8400/app/changesets/${ID}`;
const policyRows = (audit: InMemoryAuditLog) => audit.events.filter((e) => e.action === 'policy.decision' && e.changesetId === ID);

describe('MCP-8 POL-5 POL-6 submit_for_approval', () => {
  it.each<[Stage]>([['prepared'], ['approved']])(
    'SEC-9 a wrong hash answers the hash text before any change, in prepared and in approved (%s)',
    async (stage) => {
      const { tool, ctx, executor, repository, audit, reportedAll } = await setup({ stage });
      const result = plain(await tool.handler(args(ID, `sha256:${'b'.repeat(64)}`), ctx(alice, { tasks: true })));
      expect(result.isError).toBe(true);
      expect(text(result)).toBe('The change-set changed; review it again.');
      expect(reportedAll().errorCode).toBe('hash_mismatch');
      expect((await repository.get(ID))?.status).toBe(stage);
      expect(policyRows(audit)).toEqual([]);
      expect(executor.starts).toEqual([]);
    },
  );

  it.each<[Stage]>([['pending_approval'], ['executing']])('MCP-8 status other than prepared or approved answers the wrong-status text (%s)', async (stage) => {
    const { tool, ctx, executor, audit } = await setup({ stage });
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} cannot be submitted in status ${stage}.`);
    expect(policyRows(audit)).toEqual([]);
    expect(executor.starts).toEqual([]);
  });

  it('POL-5 MCP-8 a required approval moves to pending_approval and answers the fixed text and structuredContent', async () => {
    const { tool, ctx, executor, repository, tasks, audit } = await setup({ requester: 'always', items: ['a', 'b'] });
    const caller: Caller = { subject: 'always', clientId: 'mandate-mcp', groups: ['always'] };
    const result = plain(await tool.handler(args(), ctx(caller, { tasks: true })));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      `Change-set ${ID} (2 changes) awaits approval by role content_manager (step 1 of 1). Approvers decide on ${URL_OF}.`,
    );
    expect(result.structuredContent).toEqual({
      changesetId: ID,
      status: 'pending_approval',
      total: 2,
      approval: { step: 1, steps: ['content_manager'], url: URL_OF },
    });
    // An approval waits for people, not work: no task even for a declaring client.
    expect(tasks.created).toEqual([]);
    expect(executor.starts).toEqual([]);
    expect(await repository.get(ID)).toMatchObject({
      status: 'pending_approval',
      approvalRound: 1,
      awaitingRole: 'content_manager',
      approvalPlan: { reason: 'role_always', steps: ['content_manager'], widget: false, included: 2 },
      submission: {
        actor: 'always',
        groups: ['always'],
        clientId: 'mandate-mcp',
        correlationId: 'corr-8',
        at: NOW,
        role: 'always_role',
        rule: 'role:always_role/grant:all',
      },
    });
    const rows = audit.events.filter((e) => e.changesetId === ID && e.correlationId === 'corr-8');
    expect(rows.map((e) => e.action)).toEqual(['policy.decision', 'changeset.transition', 'approval.requested']);
    expect(rows[1]).toMatchObject({ actor: 'always', clientId: 'mandate-mcp', details: { from: 'prepared', to: 'pending_approval' } });
    expect(rows[2]).toMatchObject({ actor: 'always', clientId: 'mandate-mcp', details: { round: 1, step: 1, role: 'content_manager' } });
  });

  it('POL-5 above_threshold under the threshold starts and stores the submission', async () => {
    const { tool, ctx, executor } = await setup({ requester: 'threshold', items: ['a'] });
    const result = plain(await tool.handler(args(), ctx({ subject: 'threshold', groups: ['threshold'] })));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ changesetId: ID, status: 'executing', total: 1 });
    expect(executor.starts).toHaveLength(1);
    expect(executor.starts[0]?.submission).toEqual({
      actor: 'threshold',
      groups: ['threshold'],
      correlationId: 'corr-8',
      at: NOW,
      role: 'threshold_role',
      rule: 'role:threshold_role/grant:all',
    });
  });

  it('POL-5 above_threshold over the threshold routes to approval', async () => {
    const { tool, ctx, executor, repository } = await setup({ requester: 'threshold', items: ['a', 'b'] });
    const result = plain(await tool.handler(args(), ctx({ subject: 'threshold', groups: ['threshold'] })));
    expect(result.structuredContent).toMatchObject({ status: 'pending_approval', total: 2 });
    expect((await repository.get(ID))?.approvalPlan).toMatchObject({ reason: 'above_threshold', threshold: 1, included: 2 });
    expect(executor.starts).toEqual([]);
  });

  it('POL-5 a role with required approval but no steps in the snapshot answers approval_unroutable and stays prepared', async () => {
    // The loader refuses a write grant without steps, so the snapshot is built by hand.
    const base = CURRENT.configuration;
    const unroutable = snapshotOf({
      ...base,
      approval: new Map([...base.approval, ['always_role', { required: 'always' as const, steps: [], allowWidget: false }]]),
    });
    const { tool, ctx, executor, repository, reportedAll } = await setup({ requester: 'always' });
    const result = plain(await tool.handler(args(), ctx({ subject: 'always', groups: ['always'] }, { snapshot: unroutable })));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} needs approval, but its role has no approval steps configured.`);
    expect(reportedAll().errorCode).toBe('approval_unroutable');
    expect((await repository.get(ID))?.status).toBe('prepared');
    expect(executor.starts).toEqual([]);
  });

  it('POL-6 an approved change-set is started by the requester through startApproved', async () => {
    // The caller holds more groups now; the start carries the identity of the submission.
    const { tool, ctx, executor, tasks } = await setup({ stage: 'approved', requesterGroups: ['content'] });
    const caller: Caller = { subject: 'alice', clientId: 'mandate-mcp', groups: ['content', 'always'] };
    const answer = await tool.handler(args(), ctx(caller, { tasks: true }));
    expect(isTaskAnswer(answer)).toBe(true);
    expect(tasks.created).toHaveLength(1);
    expect(executor.starts).toEqual([
      {
        changesetId: ID,
        expectedHash: HASH,
        actor: 'alice',
        clientId: 'mandate-mcp',
        correlationId: 'corr-8',
        requester: { subject: 'alice', groups: ['content'] },
      },
    ]);
  });

  it('POL-6 MCP-1 an approved change-set started for a plain client answers the start text', async () => {
    const { tool, ctx } = await setup({ stage: 'approved' });
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(text(result)).toBe('Execution of 3 changes started. Call get_changeset with this ID to follow it.');
    expect(result.structuredContent).toEqual({ changesetId: ID, status: 'executing', total: 3 });
  });

  it('POL-6 MCP-8 an approved change-set whose start is refused answers the fixed text and stays approved', async () => {
    const { tool, ctx, executor, repository, audit, tasks, reportedAll } = await setup({ stage: 'approved' });
    executor.answer = { ok: false, reason: 'not_approved' };
    const result = plain(await tool.handler(args(), ctx(alice, { tasks: true })));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} lacks the approvals its execution needs.`);
    expect(reportedAll().errorCode).toBe('not_approved');
    expect(tasks.created).toEqual([]);
    expect((await repository.get(ID))?.status).toBe('approved');
    expect(audit.events.filter((e) => e.action === 'changeset.start')).toEqual([
      expect.objectContaining({ outcome: 'denied', details: expect.objectContaining({ reason: 'not_approved' }) as unknown }),
    ]);
  });

  it('POL-6 MCP-8 an approved change-set with an unreachable executor answers executor_unavailable', async () => {
    const { tool, ctx, executor, reportedAll } = await setup({ stage: 'approved' });
    executor.answer = 'unavailable';
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${ID} could not be started: the execution service is unavailable.`);
    expect(reportedAll().errorCode).toBe('executor_unavailable');
  });

  it('POL-6 a denied re-evaluation on an approved change-set does not start', async () => {
    const { tool, ctx, executor, repository, audit } = await setup({ stage: 'approved' });
    const result = plain(await tool.handler(args(), ctx(alice, { snapshot: NARROWED })));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Denied by policy: /);
    expect(policyRows(audit).map((e) => e.decision)).toEqual(['deny']);
    expect(executor.starts).toEqual([]);
    expect((await repository.get(ID))?.status).toBe('approved');
  });

  it('POL-5 a destructive operation always routes to approval', async () => {
    // content_manager is `required: never`; the destructive risk overrides it.
    const { tool, ctx, executor, repository } = await setup({ operation: 'catalog.retire_content' });
    const result = plain(await tool.handler(args(), ctx(alice)));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(`Change-set ${ID} (3 changes) awaits approval by role other_role (step 1 of 1). Approvers decide on ${URL_OF}.`);
    expect(executor.starts).toEqual([]);
    expect((await repository.get(ID))?.approvalPlan).toEqual({
      reason: 'risk_destructive',
      steps: ['other_role'],
      stepUp: { maxAgeSeconds: 120 },
      widget: false,
      included: 3,
    });
  });

  it("MCP-6 refusals for the requester's own change-set name it in structuredContent; not_found and policy denials do not", async () => {
    const unroutable = snapshotOf({
      ...CURRENT.configuration,
      approval: new Map([...CURRENT.configuration.approval, ['always_role', { required: 'always' as const, steps: [], allowWidget: false }]]),
    });
    type Run = (s: Awaited<ReturnType<typeof setup>>) => Promise<ToolAnswer>;
    const named: [string, Parameters<typeof setup>[0], Run][] = [
      ['hash mismatch', {}, (s) => s.tool.handler(args(ID, `sha256:${'b'.repeat(64)}`), s.ctx(alice))],
      ['wrong status', { stage: 'preparing' }, (s) => s.tool.handler(args(), s.ctx(alice))],
      ['expired', { expiresAt: new Date('2026-11-17T09:00:00.000Z') }, (s) => s.tool.handler(args(), s.ctx(alice))],
      [
        'approval unroutable',
        { requester: 'always' },
        (s) => s.tool.handler(args(), s.ctx({ subject: 'always', groups: ['always'] }, { snapshot: unroutable })),
      ],
      [
        'not_prepared race',
        { requester: 'carol' },
        (s) => {
          const submit = s.repository.submitForApproval.bind(s.repository);
          s.repository.submitForApproval = async (req) => {
            await submit(req);
            return { ok: false, reason: 'not_prepared' };
          };
          return s.tool.handler(args(), s.ctx(carol));
        },
      ],
      [
        'executor unavailable',
        {},
        (s) => {
          s.executor.answer = 'unavailable';
          return s.tool.handler(args(), s.ctx(alice));
        },
      ],
      ...(['hash_mismatch', 'expired', 'not_executable', 'not_approved'] as const).map((reason): [string, Parameters<typeof setup>[0], Run] => [
        `start refused ${reason}`,
        {},
        (s) => {
          s.executor.answer = { ok: false, reason };
          return s.tool.handler(args(), s.ctx(alice));
        },
      ]),
      [
        'start refused limit_exceeded',
        {},
        (s) => {
          s.executor.answer = { ok: false, reason: 'limit_exceeded', limit: 'records_per_day' };
          return s.tool.handler(args(), s.ctx(alice));
        },
      ],
    ];
    for (const [name, options, run] of named) {
      const result = plain(await run(await setup(options)));
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toEqual({ changesetId: ID });
    }
    const unnamed: [string, Parameters<typeof setup>[0], Run][] = [
      ['unknown', {}, (s) => s.tool.handler(args(UNKNOWN), s.ctx(alice))],
      ['foreign', {}, (s) => s.tool.handler(args(), s.ctx(bob))],
      ['policy denial', {}, (s) => s.tool.handler(args(), s.ctx(alice, { snapshot: NARROWED }))],
      [
        'start refused not_found',
        {},
        (s) => {
          s.executor.answer = { ok: false, reason: 'not_found' };
          return s.tool.handler(args(), s.ctx(alice));
        },
      ],
    ];
    for (const [name, options, run] of unnamed) {
      const result = plain(await run(await setup(options)));
      expect(result.isError, name).toBe(true);
      expect(result, name).not.toHaveProperty('structuredContent');
    }
  });

  it('MCP-8 the description names approval', async () => {
    const { tool } = await setup();
    expect(tool.description).toBe(
      'Submit a change-set you prepared, by its ID and hash: it is executed, or sent for approval when your role requires it.',
    );
  });
});

describe('NTF-1 submit_for_approval queues its notifications', () => {
  /** content_manager is the step-1 role of always_role's plan; always_role is the requester role. */
  const NOTIFYING = snapshotOf({
    ...CURRENT.configuration,
    notify: new Map([
      ['content_manager', { approvalRequests: ['lead-mail'], results: [] }],
      ['always_role', { approvalRequests: ['cm-mail'], results: ['cm-chat'] }],
    ]),
  });
  const queued = async (repository: InMemoryChangeSetRepository) =>
    (await repository.outbox.listFor(ID)).map(({ kind, round, step, target }) => ({ kind, round, step, target }));

  it('NTF-1 submit_for_approval queues approval_requested for the step-1 role, not the requester role', async () => {
    const { tool, ctx, repository } = await setup({ requester: 'always' });
    const result = plain(await tool.handler(args(), ctx({ subject: 'always', groups: ['always'] }, { snapshot: NOTIFYING })));
    expect(result.structuredContent).toMatchObject({ status: 'pending_approval' });
    expect(await queued(repository)).toEqual([{ kind: 'approval_requested', round: 1, step: 1, target: 'lead-mail' }]);
  });

  it('NTF-1 a submission without approval queues nothing', async () => {
    const { tool, ctx, repository, executor } = await setup();
    const result = plain(await tool.handler(args(), ctx(alice, { snapshot: NOTIFYING })));
    expect(result.structuredContent).toMatchObject({ status: 'executing' });
    expect(executor.starts).toHaveLength(1);
    expect(await queued(repository)).toEqual([]);
  });
});

