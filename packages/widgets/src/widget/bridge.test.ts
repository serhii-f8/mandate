import type { App } from '@modelcontextprotocol/ext-apps';
import { isCallToolResult, type CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalViewModel, ChangeSetViewModel } from '../model.js';
import { fromGetChangeset, fromReviewChangeset } from './adapters.js';
import { approvalActions, callTool, changeSetActions, openPage, tellModel, textOf, type WidgetApp, type WidgetTool } from './bridge.js';
import errorTextOnly from './fixtures/error-text-only.json' with { type: 'json' };
import exclude from './fixtures/exclude.json' with { type: 'json' };
import pending from './fixtures/get-changeset-pending.json' with { type: 'json' };
import getPrepared from './fixtures/get-changeset-prepared.json' with { type: 'json' };
import review from './fixtures/review-changeset.json' with { type: 'json' };
import submitPending from './fixtures/submit-pending.json' with { type: 'json' };

const A = '0b6f0c2e-8a51-4c2b-9d0e-6f1a2b3c4d5e';
const B = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const PAGE_A = `https://aiops.example.test/app/changesets/${A}`;
const HASH_A = `sha256:${'a'.repeat(64)}`;
const TOOLS: readonly WidgetTool[] = ['get_changeset', 'exclude_changeset_items', 'submit_for_approval', 'cancel_changeset', 'review_changeset', 'decide_changeset'];

function answer(json: unknown): CallToolResult {
  if (!isCallToolResult(json)) throw new Error('fixture is not a CallToolResult');
  return json;
}

const ANSWERS: Record<WidgetTool, CallToolResult> = {
  get_changeset: answer(getPrepared),
  exclude_changeset_items: answer(exclude),
  submit_for_approval: answer(submitPending),
  cancel_changeset: { content: [{ type: 'text', text: `Change-set ${A} was cancelled.` }], structuredContent: { changeset: { id: A, status: 'cancelled' } } },
  review_changeset: answer(review),
  decide_changeset: { content: [{ type: 'text', text: `Decision recorded for change-set ${A}: pending_approval.` }], structuredContent: { changesetId: A, status: 'pending_approval' } },
};

function fakeApp(caps: ReturnType<App['getHostCapabilities']> = { updateModelContext: {} }, answers: Partial<Record<WidgetTool, CallToolResult>> = {}) {
  const callServerTool = vi.fn<App['callServerTool']>((params) => {
    const name = params.name as WidgetTool;
    return Promise.resolve(answers[name] ?? ANSWERS[name]);
  });
  const openLink = vi.fn<App['openLink']>().mockResolvedValue({});
  const updateModelContext = vi.fn<App['updateModelContext']>().mockResolvedValue({});
  const getHostCapabilities = vi.fn<App['getHostCapabilities']>().mockReturnValue(caps);
  const app: WidgetApp = { callServerTool, openLink, updateModelContext, getHostCapabilities };
  return { app, callServerTool, openLink, updateModelContext };
}

function changeSetModel(): ChangeSetViewModel {
  const model = fromGetChangeset(getPrepared.structuredContent);
  if (model === undefined) throw new Error('fixture does not parse');
  return model;
}

function approvalModel(): ApprovalViewModel {
  const model = fromReviewChangeset(review.structuredContent);
  if (model === undefined) throw new Error('fixture does not parse');
  return model;
}

describe('widget bridge', () => {
  it('SEC-1 every action is a call of the mapped platform tool with the expected arguments', async () => {
    const cases: [string, (app: WidgetApp) => Promise<unknown>, string, Record<string, unknown>][] = [
      ['loadItems', (app) => changeSetActions(app, changeSetModel).loadItems({ after: 'c1', status: 'failed' }), 'get_changeset', { changeset_id: A, page_size: 50, cursor: 'c1', status: 'failed' }],
      ['loadItems first page', (app) => changeSetActions(app, changeSetModel).loadItems({}), 'get_changeset', { changeset_id: A, page_size: 50 }],
      ['refresh', (app) => changeSetActions(app, changeSetModel).refresh(), 'get_changeset', { changeset_id: A, page_size: 50 }],
      ['exclude', (app) => changeSetActions(app, changeSetModel).exclude?.({ exclude: ['UMBRELLA-0001'], include: [] }) ?? Promise.reject(new Error('none')), 'exclude_changeset_items', { changeset_id: A, hash: HASH_A, exclude: ['UMBRELLA-0001'] }],
      ['include', (app) => changeSetActions(app, changeSetModel).exclude?.({ exclude: [], include: ['UMBRELLA-0003'] }) ?? Promise.reject(new Error('none')), 'exclude_changeset_items', { changeset_id: A, hash: HASH_A, include: ['UMBRELLA-0003'] }],
      ['submit', (app) => changeSetActions(app, changeSetModel).submit?.(HASH_A) ?? Promise.reject(new Error('none')), 'submit_for_approval', { changeset_id: A, hash: HASH_A }],
      ['cancel', (app) => changeSetActions(app, changeSetModel).cancel?.() ?? Promise.reject(new Error('none')), 'cancel_changeset', { changeset_id: A }],
      ['approval loadItems', (app) => approvalActions(app, approvalModel).loadItems({ after: 'c2', status: 'pending' }), 'review_changeset', { changeset_id: A, cursor: 'c2', status: 'pending', sample_seed: 'seed-0001' }],
      ['resample', (app) => approvalActions(app, approvalModel).resample(), 'review_changeset', { changeset_id: A }],
      ['decide', (app) => approvalActions(app, approvalModel).decide?.({ decision: 'reject', hash: HASH_A, count: 2, comment: 'No.' }) ?? Promise.reject(new Error('none')), 'decide_changeset', { changeset_id: A, decision: 'reject', hash: HASH_A, count: 2, comment: 'No.' }],
    ];
    for (const [name, run, tool, args] of cases) {
      const { app, callServerTool } = fakeApp();
      await run(app);
      expect(callServerTool.mock.calls[0]?.[0], name).toEqual({ name: tool, arguments: args });
      for (const [params] of callServerTool.mock.calls) expect(TOOLS, name).toContain(params.name);
    }
    // The approval widget has no start tool.
    expect(approvalActions(fakeApp().app, approvalModel)).not.toHaveProperty('start');
  });

  it('SEC-1 an isError result becomes a failed action with its text', async () => {
    const { app } = fakeApp(undefined, { submit_for_approval: answer(errorTextOnly), cancel_changeset: { isError: true, content: [] } });
    expect(await callTool(app, 'submit_for_approval', { changeset_id: A, hash: HASH_A })).toEqual({ ok: false, message: `Change-set ${A} was not found.` });
    expect(await changeSetActions(app, changeSetModel).cancel?.()).toEqual({ ok: false, message: 'The call failed.' });
    const thrown = fakeApp();
    thrown.callServerTool.mockRejectedValue(new Error('Host rejected the request'));
    expect(await changeSetActions(thrown.app, changeSetModel).refresh()).toEqual({ ok: false, message: 'Host rejected the request' });
    // A successful call whose answer does not parse is a failure too, never a crash.
    const odd = fakeApp(undefined, { get_changeset: { content: [{ type: 'text', text: 'odd' }], structuredContent: { changeset: 1 } } });
    expect(await changeSetActions(odd.app, changeSetModel).loadItems({})).toEqual({ ok: false, message: 'odd' });
    expect(textOf({ content: [{ type: 'image', data: '', mimeType: 'image/png' }, { type: 'text', text: 'second' }] })).toBe('second');
    expect(textOf({ content: [] })).toBe('');
  });

  it('CS-5 exclude returns the new change-set and tells the model the new ID when the host allows it', async () => {
    const allowed = fakeApp({ updateModelContext: {} });
    const result = await changeSetActions(allowed.app, changeSetModel).exclude?.({ exclude: ['UMBRELLA-0001'], include: [] });
    expect(result?.ok && result.value).toMatchObject({ id: B, derivedFrom: A, status: 'prepared' });
    expect(allowed.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: 'text', text: `Change-set ${B} (prepared) replaces ${A}; use the new ID for further calls.` }],
    });

    const silent = fakeApp({});
    expect((await changeSetActions(silent.app, changeSetModel).exclude?.({ exclude: ['UMBRELLA-0001'], include: [] }))?.ok).toBe(true);
    expect(silent.updateModelContext).not.toHaveBeenCalled();

    const failing = fakeApp({ updateModelContext: {} });
    failing.updateModelContext.mockRejectedValue(new Error('not now'));
    expect((await changeSetActions(failing.app, changeSetModel).exclude?.({ exclude: ['UMBRELLA-0001'], include: [] }))?.ok).toBe(true);
    await expect(tellModel(failing.app, 'x')).resolves.toBeUndefined();

    // Submit refreshes and says the new status.
    const submitted = fakeApp({ updateModelContext: {} }, { get_changeset: answer(pending) });
    const after = await changeSetActions(submitted.app, changeSetModel).submit?.(HASH_A);
    expect(after?.ok && after.value.status).toBe('pending_approval');
    expect(submitted.callServerTool.mock.calls.map(([p]) => p.name)).toEqual(['submit_for_approval', 'get_changeset']);
    expect(submitted.updateModelContext).toHaveBeenCalledWith({ content: [{ type: 'text', text: `Change-set ${A} is now pending_approval.` }] });
  });

  it('APR-6 decide sends hash and count of the shown change-set', async () => {
    const { app, callServerTool } = fakeApp();
    const shown = approvalModel();
    const result = await approvalActions(app, () => shown).decide?.({ decision: 'approve', hash: HASH_A, count: shown.stats.included });
    expect(callServerTool.mock.calls.map(([p]) => p)).toEqual([
      { name: 'decide_changeset', arguments: { changeset_id: A, decision: 'approve', hash: HASH_A, count: 2 } },
      { name: 'review_changeset', arguments: { changeset_id: A, sample_seed: 'seed-0001' } },
    ]);
    expect(result?.ok && result.value.id).toBe(A);
    // Resample keeps the shown view and uses only the new sample.
    const resampled = await approvalActions(app, () => shown).resample();
    expect(resampled).toEqual({ ok: true, value: shown.sample });
  });

  it('MCP-8 a committed submit, cancel or decision stays a success when the refresh after it fails', async () => {
    const refreshDown: CallToolResult = { isError: true, content: [{ type: 'text', text: 'unavailable' }] };
    const submitted = fakeApp({ updateModelContext: {} }, { get_changeset: refreshDown });
    const s = await changeSetActions(submitted.app, changeSetModel).submit?.(HASH_A);
    expect(s?.ok && s.value).toMatchObject({ id: A, status: 'pending_approval', permissions: { canExclude: false, canSubmit: false, canCancel: false } });
    expect(submitted.updateModelContext).toHaveBeenCalledWith({ content: [{ type: 'text', text: `Change-set ${A} is now pending_approval.` }] });

    const cancelled = fakeApp(undefined, { get_changeset: refreshDown });
    const c = await changeSetActions(cancelled.app, changeSetModel).cancel?.();
    expect(c?.ok && c.value).toMatchObject({ id: A, status: 'cancelled', permissions: { canExclude: false, canSubmit: false, canCancel: false } });

    const decided = fakeApp(undefined, { review_changeset: refreshDown });
    const d = await approvalActions(decided.app, approvalModel).decide?.({ decision: 'approve', hash: HASH_A, count: 2 });
    expect(d?.ok && d.value).toMatchObject({ id: A, status: 'pending_approval', viewer: { canDecide: false, canStart: false } });
    // A thrown refresh and an answer without a status keep the shown status.
    const odd = fakeApp();
    odd.callServerTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] }).mockRejectedValueOnce(new Error('gone'));
    const o = await approvalActions(odd.app, approvalModel).decide?.({ decision: 'approve', hash: HASH_A, count: 2 });
    expect(o?.ok && o.value.status).toBe('pending_approval');
  });

  it('CS-8 the page address is read when the action runs, so a derived change-set opens its own page', async () => {
    const { app, openLink } = fakeApp();
    let shown = changeSetModel();
    const actions = changeSetActions(app, () => shown);
    const derived = fromGetChangeset(exclude.structuredContent);
    if (derived === undefined) throw new Error('fixture does not parse');
    shown = derived;
    await actions.openPage?.();
    await actions.export?.('xlsx');
    const pageB = `https://aiops.example.test/app/changesets/${B}`;
    expect(openLink.mock.calls).toEqual([[{ url: pageB }], [{ url: pageB }]]);
  });

  it('UI-1 a refused openLink shows the address as text', async () => {
    const refused = fakeApp();
    refused.openLink.mockResolvedValue({ isError: true });
    expect(await openPage(refused.app, PAGE_A)).toEqual({ ok: false, message: `Open this address in your browser: ${PAGE_A}` });
    const thrown = fakeApp();
    thrown.openLink.mockRejectedValue(new Error('timeout'));
    expect(await openPage(thrown.app, PAGE_A)).toEqual({ ok: false, message: `Open this address in your browser: ${PAGE_A}` });
    expect(await openPage(fakeApp().app, PAGE_A)).toEqual({ ok: true, value: undefined });
  });

  it('CS-8 export in the widget opens the trusted page', async () => {
    const { app, openLink, callServerTool } = fakeApp();
    const actions = changeSetActions(app, changeSetModel);
    expect(await actions.export?.('csv')).toEqual({ ok: true, value: undefined });
    expect(await actions.openPage?.()).toEqual({ ok: true, value: undefined });
    expect(openLink.mock.calls).toEqual([[{ url: PAGE_A }], [{ url: PAGE_A }]]);
    expect(callServerTool).not.toHaveBeenCalled();
    expect(await approvalActions(app, approvalModel).openPage?.()).toEqual({ ok: true, value: undefined });
    // Without a page address neither is offered.
    const noPage = changeSetModel();
    delete noPage.pageUrl;
    const bare = changeSetActions(app, () => noPage);
    expect(bare).not.toHaveProperty('export');
    expect(bare).not.toHaveProperty('openPage');
  });

  it('UI-4 MCP-5 the widget rollback opens the page and calls no tool', async () => {
    const { app, openLink, callServerTool } = fakeApp();
    const actions = changeSetActions(app, changeSetModel);
    expect(await actions.rollback?.()).toEqual({ ok: true, value: undefined });
    expect(openLink.mock.calls).toEqual([[{ url: PAGE_A }]]);
    expect(callServerTool).not.toHaveBeenCalled();
    const noPage = changeSetModel();
    delete noPage.pageUrl;
    expect(changeSetActions(app, () => noPage)).not.toHaveProperty('rollback');
  });
});
