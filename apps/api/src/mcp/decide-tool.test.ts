// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { approvalRequirement, ExecutorUnavailable, type Caller, type ChangeSetExecutor, type StartRequest } from '@mandate/core';
import {
  InMemoryAuditLog,
  InMemoryChangeSetRepository,
  InMemoryExecutor,
  InMemoryTaskRepository,
  recordApproval,
  ScriptedWriter,
  submitChangeSet,
} from '@mandate/testing';
import { ApprovalService } from '../approvals/approval-service.js';
import { callerFromAuthInfo } from '../auth/caller-from-auth.js';
import type { AuditDetails } from './audited-tool.js';
import { DECIDE_TOOL, decideChangesetTool, widgetApproverRoles } from './decide-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import { snapshotOf } from './tool-pipeline.js';

const ID = '11111111-1111-4111-8111-111111111111';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');
const FAR = new Date('2099-01-01T00:00:00.000Z');
/** 2026-11-17T09:59:30Z, 30 s before NOW. */
const AUTH_TIME = 1_794_909_570;

/** `writer` lets `lead` (then `brand`) decide in the widget; `auditor` is a step role of `checker`, without the widget. */
const loaded = await loadConfigurationSources([
  {
    file: 'connections.yaml',
    text: `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  },
  {
    file: 'operations.yaml',
    text: `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, fields: { type: array, items: { type: string } } }
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
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [skus, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      read_before: { operation: catalog.get_products, ids_arg: skus }
      rollback: { strategy: replay_previous_state }
`,
  },
  {
    file: 'roles.yaml',
    text: `version: 1
roles:
  - id: writer
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: always, steps: [{ role: lead }, { role: brand }], allow_widget: true }
  - id: checker
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: always, steps: [{ role: auditor }] }
  - id: lead
    grants: []
  - id: brand
    grants: []
  - id: auditor
    grants: []
role_mapping:
  - { group: content, roles: [writer] }
  - { group: leads, roles: [lead] }
  - { group: brands, roles: [brand] }
  - { group: auditors, roles: [auditor] }
`,
  },
]);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;
const SNAPSHOT = snapshotOf(CONFIG);

const bob: Caller = callerFromAuthInfo({ token: '', clientId: 'mandate-mcp', scopes: [], extra: { sub: 'bob', groups: ['leads'], auth_time: AUTH_TIME } });
const carol: Caller = { subject: 'carol', groups: ['brands'] };

/** Delegates to the in-memory executor unless made unavailable. */
class SpyExecutor implements ChangeSetExecutor {
  readonly starts: StartRequest[] = [];
  unavailable = false;
  constructor(private readonly inner: InMemoryExecutor) {}
  start(req: StartRequest): ReturnType<ChangeSetExecutor['start']> {
    this.starts.push(req);
    return this.unavailable ? Promise.reject(new ExecutorUnavailable()) : this.inner.start(req);
  }
  cancel(req: Parameters<ChangeSetExecutor['cancel']>[0]): ReturnType<ChangeSetExecutor['cancel']> {
    return this.inner.cancel(req);
  }
  progress(id: string): ReturnType<ChangeSetExecutor['progress']> {
    return this.inner.progress(id);
  }
  wake(): Promise<void> {
    return Promise.resolve();
  }

  requestRollback(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
}

async function setup(options: { steps?: readonly string[]; widget?: boolean } = {}) {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  const event = { id: 'e0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: ID,
      operation: 'catalog.update_content',
      connection: 'magento',
      requester: 'alice',
      args: { skus: ['a', 'b'] },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: FAR,
    },
    event,
  );
  await repository.appendItems(ID, ['a', 'b'].map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
  const prepared = await repository.completePreparation(
    ID,
    { status: 'prepared', hashVersion: 1, hash: HASH, stats: { total: 2, included: 2, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'e1' },
  );
  if (prepared === undefined) throw new Error('preparation failed');
  const changeset = await submitChangeSet(repository, prepared, { steps: options.steps ?? ['lead'], groups: ['content'], widget: options.widget ?? true, at: NOW });
  const executor = new SpyExecutor(new InMemoryExecutor({ repository, writer: new ScriptedWriter(), batchSizeOf: () => 100 }));
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const approvals = new ApprovalService({ repository, executor, audit, newId, now: () => NOW });
  const tool = decideChangesetTool({
    repository,
    newId,
    now: () => NOW,
    executor,
    tasks: new InMemoryTaskRepository(),
    audit,
    approvals,
    publicUrl: new URL('https://mandate.example.test'),
  });
  const reports: AuditDetails[] = [];
  const call = async (caller: Caller, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const full = { changeset_id: ID, decision: 'approve', hash: HASH, count: 2, ...args };
    const check = tool.validate(full);
    if (!check.ok) throw new Error(check.message);
    const answer: ToolAnswer = await tool.handler(full, { caller, snapshot: SNAPSHOT, correlationId: 'corr-w', tasks: false, report: (d) => reports.push(d) });
    if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
    return answer;
  };
  return { audit, repository, executor, tool, changeset, call, reports };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

describe('APR-8 decide_changeset widget tool', () => {
  it('APR-8 MCP-3 the input schema requires a uuid, a decision, a hash and a count and refuses extra arguments', async () => {
    const { tool } = await setup();
    const ok = { changeset_id: ID, decision: 'reject', hash: HASH, count: 0, comment: 'no' };
    expect(tool.validate(ok)).toEqual({ ok: true });
    for (const bad of [
      { ...ok, changeset_id: 'not-a-uuid' },
      { ...ok, decision: 'start' },
      { ...ok, hash: 'sha256:abc' },
      { ...ok, count: -1 },
      { ...ok, count: 1.5 },
      { ...ok, comment: 'x'.repeat(2001) },
      { ...ok, extra: true },
      { decision: 'approve', hash: HASH, count: 2 },
    ]) {
      expect(tool.validate(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(tool).toMatchObject({ name: DECIDE_TOOL, readOnlyHint: false, meta: { ui: { visibility: ['app'] } } });
  });

  it('AUTH-4 APR-8 decide_changeset is neither listed nor callable for a service caller holding a widget role', async () => {
    const { tool } = await setup();
    const config: LoadedConfiguration = { ...CONFIG, policy: { ...CONFIG.policy, serviceAccounts: [{ clientId: 'sa', role: 'lead' }] } };
    const sa: Caller = { subject: 'service:sa', clientId: 'sa', groups: [] };
    // `lead` is a widget step role; a user holding it by group sees the tool, the service account does not.
    expect(tool.visibleTo?.(bob, config)).toBe(true);
    expect(tool.visibleTo?.(sa, config)).toBe(false);
  });

  it('APR-8 widget approver roles are the step roles of rules with allow_widget', () => {
    expect([...widgetApproverRoles(CONFIG)].sort()).toEqual(['brand', 'lead']);
  });

  it('APR-8 a widget decision on a plan with widget true is recorded with channel widget and the token auth_time', async () => {
    const s = await setup({ steps: ['lead', 'brand'] });
    const answer = await s.call(bob);
    expect(answer.isError).toBeUndefined();
    expect(text(answer)).toBe(`Decision recorded for change-set ${ID}: pending_approval.`);
    expect(answer.structuredContent).toEqual({ changesetId: ID, status: 'pending_approval' });
    const [approval] = await s.repository.approvals(ID);
    expect(approval).toMatchObject({
      approver: 'bob',
      role: 'lead',
      decision: 'approved',
      channel: 'widget',
      clientId: 'mandate-mcp',
      authTime: new Date(AUTH_TIME * 1000),
      correlationId: 'corr-w',
    });
    expect(s.audit.events.find((e) => e.action === 'approval.decision')).toMatchObject({ outcome: 'ok', details: { channel: 'widget' } });
  });

  it('APR-8 SEC-8 a plan without widget answers widget_not_allowed text', async () => {
    const s = await setup({ widget: false });
    const answer = await s.call(bob);
    expect(answer).toEqual({ isError: true, content: [{ type: 'text', text: 'This change-set must be decided on the approval page.' }] });
    expect(s.reports).toContainEqual({ errorCode: 'widget_not_allowed' });
    expect(await s.repository.approvals(ID)).toEqual([]);
    expect(s.audit.events.at(-1)).toMatchObject({ action: 'approval.decision', outcome: 'denied', details: { reason: 'widget_not_allowed', channel: 'widget' } });
  });

  it('POL-5 a destructive change-set is never decided in the widget', async () => {
    // The role allows the widget, but the plan of a destructive change-set never does.
    const rule = CONFIG.approval.get('writer');
    const plan = approvalRequirement({ risk: 'destructive', opaque: false, ...(rule === undefined ? {} : { rule }), included: 2 });
    expect(rule?.allowWidget).toBe(true);
    if (!plan.required || plan.unroutable === true) throw new Error('expected a routable approval plan');
    expect(plan.widget).toBe(false);
    const s = await setup({ widget: plan.widget });
    const answer = await s.call(bob);
    expect(answer.isError).toBe(true);
    expect(text(answer)).toBe('This change-set must be decided on the approval page.');
    expect(await s.repository.approvals(ID)).toEqual([]);
  });

  it('APR-8 a refusal answers the fixed refusal text and reports its code', async () => {
    const s = await setup();
    const answer = await s.call(bob, { count: 3 });
    expect(text(answer)).toBe('The number of changes does not match; review the change-set again.');
    expect(answer.isError).toBe(true);
    expect(s.reports).toContainEqual({ errorCode: 'count_mismatch' });
  });

  it('APR-8 a reject carries the comment to the approval row', async () => {
    const s = await setup();
    const answer = await s.call(bob, { decision: 'reject', comment: 'wrong brand' });
    expect(text(answer)).toBe(`Decision recorded for change-set ${ID}: rejected.`);
    expect((await s.repository.approvals(ID))[0]).toMatchObject({ decision: 'rejected', comment: 'wrong brand' });
  });

  it('the last widget approval reports the start outcome', async () => {
    const s = await setup({ steps: ['lead', 'brand'] });
    await recordApproval(s.repository, s.changeset, { approver: 'bob' });
    const answer = await s.call(carol);
    expect(text(answer)).toBe(`Decision recorded for change-set ${ID}: approved. Execution started.`);
    expect(answer.structuredContent).toEqual({ changesetId: ID, status: 'approved', start: { ok: true } });
    expect(s.executor.starts).toHaveLength(1);
  });

  it('the last widget approval reports an unavailable executor', async () => {
    const s = await setup();
    s.executor.unavailable = true;
    const answer = await s.call(bob);
    expect(text(answer)).toBe(`Decision recorded for change-set ${ID}: approved. Execution did not start: executor_unavailable.`);
    expect(answer.structuredContent).toEqual({ changesetId: ID, status: 'approved', start: 'executor_unavailable' });
  });
});
