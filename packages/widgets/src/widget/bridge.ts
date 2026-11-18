/**
 * The widget's actions as ordinary platform tool calls through the MCP Apps host. Widgets hold no
 * authority: the server authorizes every call (SEC-1), and the widget calls only `WidgetTool`s.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ActionResult, ApprovalActions, ApprovalViewModel, ChangeSetActions, ChangeSetViewModel, ItemsPageModel } from '../model.js';
import { fromGetChangeset, fromReviewChangeset, textOf } from './adapters.js';

export { textOf } from './adapters.js';

export type WidgetApp = Pick<App, 'callServerTool' | 'openLink' | 'updateModelContext' | 'getHostCapabilities'>;
export type WidgetTool =
  | 'get_changeset'
  | 'exclude_changeset_items'
  | 'submit_for_approval'
  | 'cancel_changeset'
  | 'review_changeset'
  | 'decide_changeset';

const PAGE_SIZE = 50;
const CALL_FAILED = 'The call failed.';
const UNREADABLE = 'The answer could not be read.';

export async function callTool(app: WidgetApp, name: WidgetTool, args: Record<string, unknown>): Promise<ActionResult<CallToolResult>> {
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError === true) return { ok: false, message: textOf(result) || CALL_FAILED };
    return { ok: true, value: result };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : CALL_FAILED };
  }
}

/** Opens the trusted page; a refusal leaves the address as text (Review Focus 4). */
export async function openPage(app: WidgetApp, url: string): Promise<ActionResult> {
  const refused: ActionResult = { ok: false, message: `Open this address in your browser: ${url}` };
  try {
    const result = await app.openLink({ url });
    return result.isError === true ? refused : { ok: true, value: undefined };
  } catch {
    return refused;
  }
}

/** Tells the model what changed, when the host accepts context updates; never fails the action. */
export async function tellModel(app: WidgetApp, text: string): Promise<void> {
  if (app.getHostCapabilities()?.updateModelContext === undefined) return;
  try {
    await app.updateModelContext({ content: [{ type: 'text', text }] });
  } catch {
    // The context update is a courtesy to the model; the action itself succeeded.
  }
}

/** A successful call whose answer does not map is a failure with its text. */
function unreadable(result: CallToolResult): { ok: false; message: string } {
  return { ok: false, message: textOf(result) || UNREADABLE };
}

export function changeSetActions(app: WidgetApp, current: () => ChangeSetViewModel): ChangeSetActions {
  async function refresh(): Promise<ActionResult<ChangeSetViewModel>> {
    const r = await callTool(app, 'get_changeset', { changeset_id: current().id, page_size: PAGE_SIZE });
    if (!r.ok) return r;
    const model = fromGetChangeset(r.value.structuredContent);
    return model === undefined ? unreadable(r.value) : { ok: true, value: model };
  }

  const actions: ChangeSetActions = {
    async loadItems(q): Promise<ActionResult<ItemsPageModel>> {
      const r = await callTool(app, 'get_changeset', {
        changeset_id: current().id,
        page_size: PAGE_SIZE,
        ...(q.after === undefined ? {} : { cursor: q.after }),
        ...(q.status === undefined ? {} : { status: q.status }),
      });
      if (!r.ok) return r;
      const model = fromGetChangeset(r.value.structuredContent, q.status);
      return model === undefined ? unreadable(r.value) : { ok: true, value: model.items };
    },
    refresh,
    async exclude(edit) {
      const old = current();
      const r = await callTool(app, 'exclude_changeset_items', {
        changeset_id: old.id,
        ...(old.hash === undefined ? {} : { hash: old.hash }),
        ...(edit.exclude.length === 0 ? {} : { exclude: edit.exclude }),
        ...(edit.include.length === 0 ? {} : { include: edit.include }),
      });
      if (!r.ok) return r;
      const model = fromGetChangeset(r.value.structuredContent);
      if (model === undefined) return unreadable(r.value);
      await tellModel(app, `Change-set ${model.id} (${model.status}) replaces ${old.id}; use the new ID for further calls.`);
      return { ok: true, value: model };
    },
    async submit(hash) {
      const id = current().id;
      const r = await callTool(app, 'submit_for_approval', { changeset_id: id, hash });
      if (!r.ok) return r;
      const next = await refresh();
      if (next.ok) await tellModel(app, `Change-set ${id} is now ${next.value.status}.`);
      return next;
    },
    async cancel() {
      const r = await callTool(app, 'cancel_changeset', { changeset_id: current().id });
      if (!r.ok) return r;
      return refresh();
    },
  };
  // Export happens on the trusted page (ADR 0035); both are offered only with its address.
  const url = current().pageUrl;
  if (url !== undefined) {
    actions.export = () => openPage(app, url);
    actions.openPage = () => openPage(app, url);
  }
  return actions;
}

export function approvalActions(app: WidgetApp, current: () => ApprovalViewModel): ApprovalActions {
  async function reviewed(): Promise<ActionResult<ApprovalViewModel>> {
    const shown = current();
    const r = await callTool(app, 'review_changeset', { changeset_id: shown.id, sample_seed: shown.sample.seed });
    if (!r.ok) return r;
    const model = fromReviewChangeset(r.value.structuredContent);
    return model === undefined ? unreadable(r.value) : { ok: true, value: model };
  }

  const actions: ApprovalActions = {
    async loadItems(q) {
      const shown = current();
      const r = await callTool(app, 'review_changeset', {
        changeset_id: shown.id,
        ...(q.after === undefined ? {} : { cursor: q.after }),
        ...(q.status === undefined ? {} : { status: q.status }),
        sample_seed: shown.sample.seed,
      });
      if (!r.ok) return r;
      const model = fromReviewChangeset(r.value.structuredContent, q.status);
      return model === undefined ? unreadable(r.value) : { ok: true, value: model.items };
    },
    async resample() {
      // No seed, so the server picks a new one; only the sample of the answer is used.
      const r = await callTool(app, 'review_changeset', { changeset_id: current().id });
      if (!r.ok) return r;
      const model = fromReviewChangeset(r.value.structuredContent);
      return model === undefined ? unreadable(r.value) : { ok: true, value: model.sample };
    },
    async decide(input) {
      const r = await callTool(app, 'decide_changeset', {
        changeset_id: current().id,
        decision: input.decision,
        hash: input.hash,
        count: input.count,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      });
      if (!r.ok) return r;
      return reviewed();
    },
  };
  const url = current().pageUrl;
  if (url !== undefined) actions.openPage = () => openPage(app, url);
  return actions;
}
