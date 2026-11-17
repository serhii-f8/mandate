import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import {
  ExecutorUnavailable,
  type Caller,
  type ChangeSetExecutor,
  type ExecutionProgress,
  type StartOutcome,
  type StartRequest,
  type TaskRecord,
} from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryTaskRepository } from '@aiops/testing';
import type { AuditDetails } from './audited-tool.js';
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
`,
    'roles.yaml': `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.update_content, id: own-brands, scope: { brand: [${scope}] } }
    limits: { records_per_operation: 50, records_per_day: 500, concurrent_executions: 2 }
    approval: { required: never }
  - id: other_role
    grants:
      - { operation: catalog.update_content, id: all }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: other, roles: [other_role] }
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

const alice: Caller = { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] };
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

async function setup(options: { requester?: string; stage?: 'preparing' | 'prepared' | 'executing' } = {}) {
  const repository = new InMemoryChangeSetRepository();
  const tasks = new RecordingTasks();
  const audit = new InMemoryAuditLog();
  const executor = new StubExecutor();
  const event = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: ID,
      operation: 'catalog.update_content',
      connection: 'magento',
      requester: options.requester ?? 'alice',
      args: { brand: 'acme', skus: ['a', 'b', 'c'], changes: { name: 'New' } },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: new Date('2026-11-18T10:00:00.000Z'),
    },
    event,
  );
  const stage = options.stage ?? 'prepared';
  if (stage !== 'preparing') {
    await repository.appendItems(ID, ['a', 'b', 'c'].map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
    await repository.completePreparation(
      ID,
      { status: 'prepared', hash: HASH, stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
      { ...event, id: 'a1' },
    );
  }
  if (stage === 'executing') {
    const moved = await repository.transition(ID, ['prepared'], 'executing', { ...event, id: 'a2' });
    if (moved === undefined) throw new Error('transition failed');
  }
  let n = 0;
  const tool = submitForApprovalTool({
    repository,
    tasks,
    executor,
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => NOW,
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

  it('POL-5 a role without approval.required never gets approval_required and stays prepared', async () => {
    const { tool, ctx, executor, repository, reportedAll } = await setup({ requester: 'carol' });
    const result = plain(await tool.handler(args(), ctx(carol)));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('This change-set requires approval, which this installation cannot grant yet.');
    expect((await repository.get(ID))?.status).toBe('prepared');
    expect(executor.starts).toEqual([]);
    expect(reportedAll().errorCode).toBe('approval_required');
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
        clientId: 'aiops-mcp',
        limits: { role: 'content_manager', recordsPerOperation: 50, recordsPerDay: 500, concurrentExecutions: 2 },
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
    expect(task).toMatchObject({ kind: 'execute', tool: 'submit_for_approval', owner: 'alice', clientId: 'aiops-mcp', changesetId: ID });
    expect(await tasks.findOwned(task?.taskId ?? '', 'alice')).toEqual(task);
    expect(isTaskAnswer(answer) ? answer.taskId : undefined).toBe(task?.taskId);
    expect(reportedAll().taskId).toBe(task?.taskId);
  });
});
