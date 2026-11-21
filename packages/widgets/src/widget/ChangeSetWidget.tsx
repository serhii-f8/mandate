// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { POLLED_STATUSES, type ChangeSetViewModel } from '../model.js';
import { usePolling } from '../poll.js';
import { ChangeSetView } from '../views/ChangeSetView.js';
import { fromGetChangeset, parseChangeSetTrigger } from './adapters.js';
import { callTool, changeSetActions, textOf, type WidgetApp } from './bridge.js';
import { PageLink, TextResult } from './TextResult.js';

const FULL_PAGE = 50;
const UNREADABLE = 'The answer could not be read.';

type Shown =
  | { kind: 'waiting' }
  | { kind: 'loading'; id: string; pageUrl?: string }
  | { kind: 'view'; model: ChangeSetViewModel }
  | { kind: 'text'; text: string; pageUrl?: string };

/** The stored change-set with its first items page, or the answer's text when it does not map. */
async function load(app: WidgetApp, id: string): Promise<{ ok: true; model: ChangeSetViewModel } | { ok: false; text: string }> {
  const r = await callTool(app, 'get_changeset', { changeset_id: id, page_size: FULL_PAGE });
  if (!r.ok) return { ok: false, text: r.message };
  const model = fromGetChangeset(r.value.structuredContent);
  return model === undefined ? { ok: false, text: textOf(r.value) || UNREADABLE } : { ok: true, model };
}

/**
 * The change-set widget (UI-1, UI-2, UI-3): the result that opened it as the shared view, polled
 * while the change-set moves on. The widget holds no authority; every call is a platform tool call.
 */
export function ChangeSetWidget(props: { app: WidgetApp | null; trigger: CallToolResult | undefined; tornDown: boolean; error?: Error }): ReactElement {
  const { app, trigger, tornDown } = props;
  const [shown, setShown] = useState<Shown>({ kind: 'waiting' });
  const model = shown.kind === 'view' ? shown.model : undefined;
  // Actions and polls run after renders; the ref gives them the change-set shown now.
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (trigger === undefined) return;
    const parsed = parseChangeSetTrigger(trigger);
    if (parsed.kind === 'view') setShown({ kind: 'view', model: parsed.model });
    else if (parsed.kind === 'text') setShown(parsed);
    else setShown({ kind: 'loading', id: parsed.id, ...(parsed.pageUrl === undefined ? {} : { pageUrl: parsed.pageUrl }) });
  }, [trigger]);

  const loadingId = shown.kind === 'loading' ? shown.id : undefined;
  const loadingUrl = shown.kind === 'loading' ? shown.pageUrl : undefined;
  useEffect(() => {
    if (app === null || loadingId === undefined) return undefined;
    let live = true;
    void load(app, loadingId).then((r) => {
      if (!live) return;
      if (r.ok) setShown({ kind: 'view', model: r.model });
      else setShown({ kind: 'text', text: r.text, ...(loadingUrl === undefined ? {} : { pageUrl: loadingUrl }) });
    });
    return () => {
      live = false;
    };
  }, [app, loadingId, loadingUrl]);

  // The bridge offers the page actions only with a page address, read when the set is built: it is
  // built once a change-set is shown and again when the address appears or goes.
  const shape = model === undefined ? 'none' : model.pageUrl === undefined ? 'no-page' : 'page';
  const actions = useMemo(() => {
    if (app === null || shape === 'none') return undefined;
    const current = (): ChangeSetViewModel => {
      const m = modelRef.current;
      if (m === undefined) throw new Error('no change-set is shown');
      return m;
    };
    return changeSetActions(app, current);
  }, [app, shape]);

  // A poll reads the header only (page_size 1) and keeps the shown items; a new status loads the
  // change-set again with its first items page, and the view remounts with it (ruling F4).
  const poll = useCallback(async (): Promise<void> => {
    const before = modelRef.current;
    if (app === null || before === undefined) return;
    const r = await callTool(app, 'get_changeset', { changeset_id: before.id, page_size: 1 });
    if (!r.ok) return;
    const polled = fromGetChangeset(r.value.structuredContent);
    if (polled?.id !== before.id) return;
    if (polled.status === before.status) {
      setShown((s) =>
        s.kind === 'view' && s.model.id === polled.id && s.model.status === polled.status
          ? { kind: 'view', model: { ...polled, items: s.model.items, ...(s.model.itemFilter === undefined ? {} : { itemFilter: s.model.itemFilter }) } }
          : s,
      );
      return;
    }
    const full = await load(app, before.id);
    if (!full.ok) return;
    setShown((s) => (s.kind === 'view' && s.model.id === before.id ? { kind: 'view', model: full.model } : s));
  }, [app]);
  const polling = usePolling(model !== undefined && POLLED_STATUSES.includes(model.status) && !tornDown, poll);

  if (props.error !== undefined) return <p role="alert">The widget could not connect to the host.</p>;
  if (shown.kind === 'waiting') return <p>Waiting for data…</p>;
  if (shown.kind === 'text') return <TextResult app={app} text={shown.text} pageUrl={shown.pageUrl} />;
  if (shown.kind === 'loading' || actions === undefined) {
    return (
      <>
        <p>Loading…</p>
        {shown.kind === 'loading' && shown.pageUrl !== undefined ? <PageLink app={app} url={shown.pageUrl} /> : null}
      </>
    );
  }
  return (
    <>
      <ChangeSetView
        data={shown.model}
        actions={actions}
        onData={(next) => {
          setShown({ kind: 'view', model: next });
        }}
      />
      {polling.stopped ? (
        <button type="button" onClick={polling.restart}>
          Refresh
        </button>
      ) : null}
    </>
  );
}
