// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, ChangeSetActions, ChangeSetViewModel, ItemsPageModel } from '../model.js';
import { HASH, changeSetModel, item, opaqueChangeSetModel } from '../test-fixtures.js';
import { PreviewView } from './PreviewView.js';
import { type Action, useAction } from './useAction.js';

afterEach(cleanup);

type Result = Promise<ActionResult<ChangeSetViewModel>>;

type Offered = 'exclude' | 'submit' | 'export' | 'openPage';

function actionsWith(over: Partial<ChangeSetActions> = {}, without: Offered[] = []): ChangeSetActions {
  const actions: ChangeSetActions = {
    loadItems: vi.fn<ChangeSetActions['loadItems']>().mockResolvedValue({ ok: true, value: { items: [] } }),
    refresh: vi.fn<ChangeSetActions['refresh']>().mockResolvedValue({ ok: true, value: changeSetModel() }),
    exclude: vi.fn<NonNullable<ChangeSetActions['exclude']>>(),
    submit: vi.fn<NonNullable<ChangeSetActions['submit']>>(),
    export: vi.fn<NonNullable<ChangeSetActions['export']>>().mockResolvedValue({ ok: true, value: undefined }),
    openPage: vi.fn<NonNullable<ChangeSetActions['openPage']>>().mockResolvedValue({ ok: true, value: undefined }),
    ...over,
  };
  if (without.includes('exclude')) delete actions.exclude;
  if (without.includes('submit')) delete actions.submit;
  if (without.includes('export')) delete actions.export;
  if (without.includes('openPage')) delete actions.openPage;
  return actions;
}

function setup(data: ChangeSetViewModel = changeSetModel(), actions: ChangeSetActions = actionsWith()) {
  const onData = vi.fn<(next: ChangeSetViewModel) => void>();
  const view = render(<PreviewView data={data} actions={actions} onData={onData} />);
  return { ...view, onData, actions };
}

const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name });
const flush = (): Promise<void> => act(() => Promise.resolve());

describe('PreviewView', () => {
  it('UI-3 the preview shows title, status, statistics, hash and expiry', () => {
    const { container } = setup();
    expect(screen.getByRole('heading').textContent).toContain('Update product content');
    expect(container.querySelector('.status-prepared')?.textContent).toBe('prepared');
    expect(container.textContent).toContain('3 changes · 1 excluded (no_change 1)');
    expect(container.querySelector(`[title="${HASH}"]`)?.textContent).toBe('sha256:6114edb2…');
    expect(container.textContent).toContain('Expires ');
  });

  it('UI-3 the title falls back to the operation ID', () => {
    setup(changeSetModel({ operation: { id: 'update_product_content' } }));
    expect(screen.getByRole('heading').textContent).toContain('update_product_content');
  });

  it('UI-3 the submit button states the count and sends the shown hash', async () => {
    const submit = vi.fn<NonNullable<ChangeSetActions['submit']>>().mockResolvedValue({
      ok: true,
      value: changeSetModel({ status: 'executing' }),
    });
    const { onData } = setup(changeSetModel(), actionsWith({ submit }));
    fireEvent.click(button('Submit 3 changes'));
    await flush();
    expect(submit).toHaveBeenCalledWith(HASH);
    expect(onData).toHaveBeenCalledWith(changeSetModel({ status: 'executing' }));
    cleanup();
    setup(changeSetModel({ stats: { total: 1, included: 1, excluded: {}, written: 0, failed: 0, skipped: 0 } }));
    expect(button('Submit 1 change')).toBeTruthy();
  });

  it('CS-5 UI-3 exclude sends the selected pending and requester-excluded items and replaces the data', async () => {
    const next = changeSetModel({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    const exclude = vi.fn<NonNullable<ChangeSetActions['exclude']>>().mockResolvedValue({ ok: true, value: next });
    const data = changeSetModel({
      items: { items: [item('sku-1'), item('sku-9', { status: 'excluded', reason: 'requester' })] },
    });
    const { onData, rerender, actions } = setup(data, actionsWith({ exclude }));
    fireEvent.click(screen.getByLabelText('Select sku-1'));
    fireEvent.click(screen.getByLabelText('Select sku-9'));
    expect(button('Include selected (1)').disabled).toBe(false);
    fireEvent.click(button('Exclude selected (1)'));
    await flush();
    expect(exclude).toHaveBeenCalledTimes(1);
    expect(exclude).toHaveBeenCalledWith({ exclude: ['sku-1'], include: ['sku-9'] });
    expect(onData).toHaveBeenCalledWith(next);
    expect(screen.getByRole('status').textContent).toBe('New change-set aaaaaaaa; the previous one is unchanged.');
    expect(button('Exclude selected (0)').disabled).toBe(true);
    expect(button('Include selected (0)').disabled).toBe(true);
    rerender(<PreviewView data={next} actions={actions} onData={onData} />);
    expect(screen.getByText('New change-set aaaaaaaa; the previous one is unchanged.')).toBeTruthy();
  });

  it('UI-3 a refused exclusion shows its message', async () => {
    const exclude = vi.fn<NonNullable<ChangeSetActions['exclude']>>().mockRejectedValue(new Error('network down'));
    setup(changeSetModel(), actionsWith({ exclude }));
    fireEvent.click(screen.getByLabelText('Select sku-1'));
    fireEvent.click(button('Exclude selected (1)'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Not excluded: network down');
  });

  it('UI-3 rows excluded by the system cannot be selected', () => {
    setup();
    expect(screen.getByLabelText('Select sku-1')).toBeTruthy();
    expect(screen.queryByLabelText('Select sku-4')).toBeNull();
  });

  it('UI-3 rows are not selectable without permissions.canExclude', () => {
    setup(changeSetModel({ permissions: { canExclude: false, canSubmit: true, canCancel: true } }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Exclude selected/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Include selected/ })).toBeNull();
  });

  it(
    'UI-3 selection stops at 1000 and is cleared when the filter changes',
    async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => item(`sku-${String(i)}`));
      const loadItems = vi
        .fn<ChangeSetActions['loadItems']>()
        .mockResolvedValue({ ok: true, value: { items: [] } satisfies ItemsPageModel });
      const { container } = setup(changeSetModel({ items: { items: rows } }), actionsWith({ loadItems }));
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
      expect(boxes).toHaveLength(1001);
      for (const box of boxes.slice(0, 1000)) fireEvent.click(box);
      const last = boxes[1000];
      expect(last?.disabled).toBe(true);
      expect(last?.checked).toBe(false);
      if (last) fireEvent.click(last);
      expect(button('Exclude selected (1000)')).toBeTruthy();
      expect(screen.getByText('At most 1000 items can be selected at once.')).toBeTruthy();
      fireEvent.click(button('Excluded'));
      expect(button('Exclude selected (0)').disabled).toBe(true);
      expect(button('Include selected (0)').disabled).toBe(true);
      await flush();
      expect(loadItems).toHaveBeenCalledWith({ status: 'excluded' });
      expect(button('Excluded').getAttribute('aria-pressed')).toBe('true');
      expect(button('All').getAttribute('aria-pressed')).toBe('false');
    },
    60_000,
  );

  it('UI-3 one action at a time', async () => {
    let resolve: (r: ActionResult<ChangeSetViewModel>) => void = () => undefined;
    const submit = vi.fn<NonNullable<ChangeSetActions['submit']>>(
      (): Result =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const exclude = vi.fn<NonNullable<ChangeSetActions['exclude']>>();
    setup(changeSetModel(), actionsWith({ submit, exclude }));
    fireEvent.click(screen.getByLabelText('Select sku-1'));
    const submitButton = button('Submit 3 changes');
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);
    expect(submit).toHaveBeenCalledTimes(1);
    for (const name of ['Submit 3 changes', 'Exclude selected (1)', 'Export CSV', 'Export XLSX', 'Open as page']) {
      expect(button(name).disabled).toBe(true);
    }
    fireEvent.click(button('Exclude selected (1)'));
    expect(exclude).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ ok: true, value: changeSetModel() });
      await Promise.resolve();
    });
    expect(button('Submit 3 changes').disabled).toBe(false);
    expect(button('Exclude selected (1)').disabled).toBe(false);
  });

  it('UI-3 a refused submit shows its message', async () => {
    const submit = vi
      .fn<NonNullable<ChangeSetActions['submit']>>()
      .mockResolvedValue({ ok: false, message: 'expired' });
    const { onData } = setup(changeSetModel(), actionsWith({ submit }));
    fireEvent.click(button('Submit 3 changes'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Not submitted: expired');
    expect(onData).not.toHaveBeenCalled();
  });

  it('UI-3 APR-6 pending_approval after submit shows the waiting notice', async () => {
    const submit = vi.fn<NonNullable<ChangeSetActions['submit']>>().mockResolvedValue({
      ok: true,
      value: changeSetModel({ status: 'pending_approval' }),
    });
    const { onData } = setup(changeSetModel(), actionsWith({ submit }));
    fireEvent.click(button('Submit 3 changes'));
    await flush();
    expect(onData).toHaveBeenCalledWith(changeSetModel({ status: 'pending_approval' }));
    expect(screen.getByRole('status').textContent).toBe(
      'Submitted for approval. Approvers decide on the approval page.',
    );
  });

  it('CS-8 export buttons call actions.export with the format', async () => {
    const exportFn = vi
      .fn<NonNullable<ChangeSetActions['export']>>()
      .mockResolvedValue({ ok: true, value: undefined });
    setup(changeSetModel(), actionsWith({ export: exportFn }));
    fireEvent.click(button('Export CSV'));
    await flush();
    fireEvent.click(button('Export XLSX'));
    await flush();
    expect(exportFn.mock.calls).toEqual([['csv'], ['xlsx']]);
  });

  it('UI-3 actions the entry does not offer are not shown', () => {
    setup(
      changeSetModel({ permissions: { canExclude: true, canSubmit: false, canCancel: true } }),
      actionsWith({}, ['openPage', 'export']),
    );
    expect(screen.queryByRole('button', { name: 'Open as page' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Export/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull();
    cleanup();
    setup(changeSetModel(), actionsWith({}, ['exclude', 'submit']));
    expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /selected/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('NFR-8 the pager loads the next page through actions.loadItems', async () => {
    const loadItems = vi
      .fn<ChangeSetActions['loadItems']>()
      .mockResolvedValue({ ok: true, value: { items: [item('sku-51')] } });
    setup(changeSetModel({ items: { items: [item('sku-1')], next: 'c2' } }), actionsWith({ loadItems }));
    fireEvent.click(button('Next'));
    await flush();
    expect(loadItems).toHaveBeenCalledWith({ after: 'c2' });
    expect(screen.getByText('sku-51')).toBeTruthy();
    expect(screen.queryByText('sku-1')).toBeNull();
  });
});

describe('useAction', () => {
  function probe(): () => Action {
    const ref: { current: Action | undefined } = { current: undefined };
    function Probe() {
      ref.current = useAction();
      return null;
    }
    render(<Probe />);
    return () => {
      if (!ref.current) throw new Error('not rendered');
      return ref.current;
    };
  }

  it('UI-3 a second run before the first settles makes no call, even within one render', async () => {
    const get = probe();
    const call = vi.fn(() => new Promise<ActionResult<number>>(() => undefined));
    const onOk = vi.fn();
    await act(() => {
      get().run('p: ', call, onOk);
      get().run('p: ', call, onOk);
      return Promise.resolve();
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(get().busy).toBe(true);
  });

  it('UI-3 a throwing call shows its message with the prefix and frees the action', async () => {
    const get = probe();
    await act(() => {
      get().run(
        'Not cancelled: ',
        () => {
          throw new Error('boom');
        },
        vi.fn(),
      );
      return Promise.resolve();
    });
    expect(get().message).toBe('Not cancelled: boom');
    expect(get().busy).toBe(false);
  });

  it('UI-2 APR-5 the opaque preview shows the raw arguments as text and no item table or exclusion', () => {
    const { container } = setup(opaqueChangeSetModel());
    expect(screen.getByRole('heading', { name: 'Raw arguments' })).toBeTruthy();
    expect(screen.getByText('This call has no preview and cannot be rolled back.')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /Exclude selected/ })).toBeNull();
    expect(button('Submit 1 change')).toBeTruthy();
  });

  it('UI-3 CS-8 the opaque preview offers export of its one row', async () => {
    const exportFn = vi
      .fn<NonNullable<ChangeSetActions['export']>>()
      .mockResolvedValue({ ok: true, value: undefined });
    setup(opaqueChangeSetModel(), actionsWith({ export: exportFn }));
    fireEvent.click(button('Export CSV'));
    await flush();
    fireEvent.click(button('Export XLSX'));
    await flush();
    expect(exportFn.mock.calls).toEqual([['csv'], ['xlsx']]);
  });
});
