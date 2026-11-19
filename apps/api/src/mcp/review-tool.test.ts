import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { encodeCursor, type Caller, type ChangeItemRecord } from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryExecutor, InMemoryTaskRepository, ScriptedWriter, submitChangeSet } from '@aiops/testing';
import { ApprovalService } from '../approvals/approval-service.js';
import { changesetDetailWith, itemRow, widgetViewerBlock } from '../approvals/detail.js';
import type { AuditDetails } from './audited-tool.js';
import { REVIEW_TOOL, approvalStepRoles, reviewChangesetTool } from './review-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import { snapshotOf } from './tool-pipeline.js';

const ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');
const FAR = new Date('2099-01-01T00:00:00.000Z');

/** `writer` routes to `lead` with the widget; `checker` routes to `auditor` without it. */
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
    approval: { required: always, steps: [{ role: lead }], allow_widget: true }
  - id: checker
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: always, steps: [{ role: auditor }] }
  - id: lead
    grants: []
  - id: auditor
    grants: []
role_mapping:
  - { group: content, roles: [writer] }
  - { group: leads, roles: [lead] }
  - { group: auditors, roles: [auditor] }
`,
  },
]);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;
const SNAPSHOT = snapshotOf(CONFIG);

const dave: Caller = { subject: 'dave', groups: ['leads'], clientId: 'aiops-mcp' };
const bob: Caller = { subject: 'bob', groups: ['content'] };
const ivy: Caller = { subject: 'ivy', groups: ['auditors'] };
const ARGS = { skus: ['a', 'b'], changes: { name: 'New' } };

const target = (i: number): string => `sku-${String(i).padStart(4, '0')}`;

async function setup(options: { items?: number; widget?: boolean; after?: (i: number) => unknown } = {}) {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  const event = { id: 'e0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  const n = options.items ?? 2;
  await repository.create(
    { id: ID, operation: 'catalog.update_content', connection: 'magento', requester: 'alice', args: ARGS, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: FAR },
    event,
  );
  const items: ChangeItemRecord[] = Array.from({ length: n }, (_, i) => ({
    targetId: target(i + 1),
    // Every third item is excluded so the status filter has something to narrow.
    ...(i % 3 === 2 ? { status: 'excluded' as const, reason: 'no_change' } : { status: 'pending' as const }),
    before: { name: 'Old' },
    after: options.after?.(i) ?? { name: 'New' },
  }));
  await repository.appendItems(ID, items);
  const excluded = items.filter((i) => i.status === 'excluded').length;
  const prepared = await repository.completePreparation(
    ID,
    { status: 'prepared', hash: HASH, stats: { total: n, included: n - excluded, excluded: excluded === 0 ? {} : { no_change: excluded }, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'e1' },
  );
  if (prepared === undefined) throw new Error('preparation failed');
  const changeset = await submitChangeSet(repository, prepared, { steps: ['lead'], groups: ['content'], widget: options.widget ?? true, at: NOW });
  const executor = new InMemoryExecutor({ repository, writer: new ScriptedWriter(), batchSizeOf: () => 100 });
  let k = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
  const tool = reviewChangesetTool({
    repository,
    newId,
    now: () => NOW,
    executor,
    tasks: new InMemoryTaskRepository(),
    audit,
    approvals: new ApprovalService({ repository, executor, audit, newId, now: () => NOW }),
    publicUrl: new URL('https://aiops.example.test'),
  });
  const reports: AuditDetails[] = [];
  const call = async (caller: Caller, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const full = { changeset_id: ID, ...args };
    const check = tool.validate(full);
    if (!check.ok) throw new Error(check.message);
    const answer: ToolAnswer = await tool.handler(full, { caller, snapshot: SNAPSHOT, correlationId: 'corr-r', tasks: false, report: (d) => reports.push(d) });
    if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
    return answer;
  };
  return { audit, repository, changeset, tool, call, reports };
}

interface Answer {
  changesetId: string;
  detail: { request: { args: unknown }; viewer: { canDecide: boolean; reason: string | null } };
  items: { targetId: string; status: string }[];
  nextCursor?: string;
  sample: { seed: string; items: { targetId: string }[] };
}

const answerOf = (r: CallToolResult): Answer => r.structuredContent as Answer;
const first = (r: CallToolResult): string => (r.content[0]?.type === 'text' ? r.content[0].text : '');

describe('APR-8 review_changeset approver tool', () => {
  it('MCP-3 the input schema takes a uuid, a cursor, a status and a seed and refuses anything else', async () => {
    const { tool } = await setup();
    expect(tool.validate({ changeset_id: ID, cursor: 'abc', status: 'pending', sample_seed: 'seed-0001' })).toEqual({ ok: true });
    for (const bad of [
      { changeset_id: 'nope' },
      { changeset_id: ID, cursor: 'x'.repeat(513) },
      { changeset_id: ID, status: 'done' },
      { changeset_id: ID, sample_seed: 'bad seed' },
      { changeset_id: ID, sample_seed: 'x'.repeat(65) },
      { changeset_id: ID, page_size: 10 },
      {},
    ]) {
      expect(tool.validate(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(tool).toMatchObject({ name: REVIEW_TOOL, widget: 'approval' });
    expect(tool.readOnlyHint ?? true).toBe(true);
  });

  it('MCP-2 APR-8 review_changeset is visible to holders of any approval step role and to nobody else', async () => {
    const { tool } = await setup();
    expect([...approvalStepRoles(CONFIG)].sort()).toEqual(['auditor', 'lead']);
    expect(tool.visibleTo?.(dave, CONFIG)).toBe(true);
    // `checker` has no allow_widget; its step role still sees the review.
    expect(tool.visibleTo?.(ivy, CONFIG)).toBe(true);
    expect(tool.visibleTo?.(bob, CONFIG)).toBe(false);
    expect(tool.visibleTo?.({ subject: 'nobody', groups: [] }, CONFIG)).toBe(false);
  });

  it('APR-5 the answer is the stored detail, one item page and a seeded sample', async () => {
    const s = await setup({ items: 60 });
    const answer = await s.call(dave, { sample_seed: 'seed-0001' });
    expect(answer.isError).toBeUndefined();
    const a = answerOf(answer);
    expect(a.changesetId).toBe(ID);
    expect(a.detail.request.args).toEqual(ARGS);
    const cs = await s.repository.get(ID);
    if (cs === undefined) throw new Error('missing change-set');
    const approvals = await s.repository.approvals(ID);
    const operation = CONFIG.policy.operations.find((op) => op.id === cs.operation);
    expect(a.detail).toEqual(
      changesetDetailWith({
        changeset: cs,
        approvals,
        ...(operation === undefined ? {} : { operation }),
        viewer: widgetViewerBlock(cs, approvals, { subject: 'dave', roles: ['lead'], clientId: 'aiops-mcp' }, NOW),
        rollback: { available: false },
      }),
    );
    expect(a.items).toHaveLength(50);
    const [stored] = await s.repository.itemsPage(ID, { limit: 1 });
    if (stored === undefined) throw new Error('missing item');
    expect(a.items[0]).toEqual(itemRow(stored));
    expect(a.nextCursor).toBe(encodeCursor(target(50)));
    expect(a.sample.seed).toBe('seed-0001');
    expect(a.sample.items).toHaveLength(10);
    const again = answerOf(await s.call(dave, { sample_seed: 'seed-0001' }));
    expect(again.sample).toEqual(a.sample);
    const fresh = answerOf(await s.call(dave));
    expect(fresh.sample.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.content[1]).toEqual({ type: 'text', text: JSON.stringify(answer.structuredContent) });
  });

  it('NFR-8 the cursor and status filter page the items; a tampered cursor is an input error', async () => {
    const s = await setup({ items: 60 });
    const page1 = answerOf(await s.call(dave));
    const page2 = answerOf(await s.call(dave, { cursor: page1.nextCursor }));
    expect(page2.items.map((i) => i.targetId)).toEqual(Array.from({ length: 10 }, (_, i) => target(51 + i)));
    expect(page2.nextCursor).toBeUndefined();
    const excluded = answerOf(await s.call(dave, { status: 'excluded' }));
    expect(excluded.items).toHaveLength(20);
    expect(excluded.items.every((i) => i.status === 'excluded')).toBe(true);
    expect(excluded.nextCursor).toBeUndefined();
    // 'AA' decodes to NUL, which PostgreSQL refuses as text: an input error, never a 500.
    for (const cursor of ['not*base64', 'AA', Buffer.from('a\u001fb', 'utf8').toString('base64url')]) {
      expect(await s.call(dave, { cursor }), cursor).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool review_changeset: cursor is not valid' }],
      });
    }
  });

  it('APR-8 canDecide follows the widget channel and the text says why not', async () => {
    const yes = await setup();
    const ok = await yes.call(dave);
    expect(first(ok)).toBe(`Change-set ${ID} (catalog.update_content) awaits lead: 2 change(s), hash ${HASH}. You can decide it here or on the page.`);
    expect(answerOf(ok).detail.viewer).toMatchObject({ canDecide: true, reason: null });
    expect(yes.reports).toContainEqual({ canDecide: true });

    const no = await setup({ widget: false });
    const refused = await no.call(dave);
    expect(refused.isError).toBeUndefined();
    expect(first(refused)).toBe(`Change-set ${ID} (catalog.update_content) awaits lead: 2 change(s), hash ${HASH}. This change-set must be decided on the approval page.`);
    expect(answerOf(refused).detail.viewer).toMatchObject({ canDecide: false, reason: 'widget_not_allowed' });
  });

  it('CS-6 APR-8 a decided change-set uses the status form and reads without writing', async () => {
    const s = await setup();
    const before = s.audit.events.length;
    await s.repository.transition(ID, ['pending_approval'], 'rejected', { id: 'e9', actor: 'dave', action: 'changeset.transition', outcome: 'ok', correlationId: 'c9', details: {} });
    const answer = await s.call(dave);
    expect(first(answer)).toBe(`Change-set ${ID} (catalog.update_content) is rejected: 2 change(s), hash ${HASH}. Change-set ${ID} is not awaiting approval.`);
    expect(answerOf(answer).detail.viewer).toMatchObject({ canDecide: false, reason: 'not_pending' });
    // Only the transition above was written; the review itself writes nothing.
    expect(s.audit.events.length).toBe(before + 1);
  });

  it('SEC-1 a change-set the caller may not view answers not found, like an unknown ID', async () => {
    const s = await setup();
    // ivy holds a step role, but not one of this change-set's plan.
    const foreign = await s.call(ivy);
    const unknown = await s.call(dave, { changeset_id: UNKNOWN });
    expect(foreign).toEqual({ isError: true, content: [{ type: 'text', text: `Change-set ${ID} was not found.` }] });
    expect(unknown).toEqual({ isError: true, content: [{ type: 'text', text: `Change-set ${UNKNOWN} was not found.` }] });
    expect(s.reports).toEqual([]);
  });

  it('SEC-5 the text carries no item value', async () => {
    const s = await setup({ after: () => ({ name: '<b>secret-value</b>' }) });
    const answer = await s.call(dave);
    expect(first(answer)).not.toContain('secret-value');
    expect(JSON.stringify(answer.structuredContent)).toContain('<b>secret-value</b>');
  });

  it('AUD-1 the tool.call row records changesetId and canDecide', async () => {
    // The pipeline reports `changesetId` from the arguments (tool-pipeline.ts); the handler adds `canDecide`.
    const s = await setup({ widget: false });
    await s.call(dave);
    expect(s.reports).toEqual([{ canDecide: false }]);
  });

  it('UI-4 review_changeset reports the caller\'s rollback block, as get_changeset does (T11/F3)', async () => {
    const s = await setup();
    const alice: Caller = { subject: 'alice', groups: ['content', 'leads'] };
    const blockOf = (r: CallToolResult): unknown => (r.structuredContent as { detail: { rollback: unknown } }).detail.rollback;
    // The requester may view it here too: the one eligibility function answers for her.
    expect(blockOf(await s.call(alice))).toStrictEqual({ available: false, reason: 'not_finished' });
    // An approver is never offered the rollback, nor told why.
    expect(blockOf(await s.call(dave))).toStrictEqual({ available: false });
  });
});
