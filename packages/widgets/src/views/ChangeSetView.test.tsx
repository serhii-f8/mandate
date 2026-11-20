import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSetActions, ChangeSetViewModel } from '../model.js';
import { changeSetModel, item, opaqueChangeSetModel } from '../test-fixtures.js';
import { ChangeSetView } from './ChangeSetView.js';

afterEach(cleanup);

function actionsWith(over: Partial<ChangeSetActions> = {}): ChangeSetActions {
  return {
    loadItems: vi.fn<ChangeSetActions['loadItems']>().mockResolvedValue({ ok: true, value: { items: [] } }),
    refresh: vi.fn<ChangeSetActions['refresh']>().mockResolvedValue({ ok: true, value: changeSetModel() }),
    submit: vi.fn<NonNullable<ChangeSetActions['submit']>>(),
    ...over,
  };
}

function setup(data: ChangeSetViewModel, actions: ChangeSetActions = actionsWith()) {
  const onData = vi.fn<(next: ChangeSetViewModel) => void>();
  const view = render(<ChangeSetView data={data} actions={actions} onData={onData} />);
  return { ...view, onData, actions };
}

const flush = (): Promise<void> => act(() => Promise.resolve());

const progress = { total: 10, done: 4, failed: 1, skipped: 2 };
const finished = { total: 10, included: 10, excluded: {}, written: 7, failed: 2, skipped: 1 };

describe('ChangeSetView', () => {
  it('UI-2 the switch shows preview, progress or result by status', async () => {
    const { rerender } = setup(changeSetModel());
    expect(screen.getByRole('button', { name: /^Submit / })).toBeTruthy();

    const actions = actionsWith();
    rerender(
      <ChangeSetView data={changeSetModel({ status: 'executing', progress })} actions={actions} onData={vi.fn()} />,
    );
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Submit / })).toBeNull();

    rerender(
      <ChangeSetView
        data={changeSetModel({ status: 'completed', stats: finished })}
        actions={actions}
        onData={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain('written');
    expect(screen.queryByRole('progressbar')).toBeNull();

    rerender(<ChangeSetView data={changeSetModel({ status: 'preparing' })} actions={actions} onData={vi.fn()} />);
    expect(document.body.textContent).toContain('Being prepared…');
  });

  it('UI-2 progress shows counts and a cancel action while executing', async () => {
    const cancelled = changeSetModel({ status: 'cancelled', stats: finished });
    const cancel = vi.fn<NonNullable<ChangeSetActions['cancel']>>().mockResolvedValue({ ok: true, value: cancelled });
    const { onData } = setup(changeSetModel({ status: 'executing', progress }), actionsWith({ cancel }));
    const bar = screen.getByRole<HTMLProgressElement>('progressbar');
    expect(bar.max).toBe(10);
    expect(bar.value).toBe(7);
    expect(document.body.textContent).toContain('4 done · 1 failed · 2 skipped of 10');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(cancelled);
  });

  it('UI-2 Cancel shows only while executing, with the action and the permission', () => {
    const cancel = vi.fn<NonNullable<ChangeSetActions['cancel']>>();
    const executing = changeSetModel({ status: 'executing', progress });
    const cases: [ChangeSetViewModel, ChangeSetActions][] = [
      [executing, actionsWith()],
      [
        changeSetModel({
          status: 'executing',
          progress,
          permissions: { canExclude: false, canSubmit: false, canCancel: false },
        }),
        actionsWith({ cancel }),
      ],
      [changeSetModel({ status: 'approved', progress }), actionsWith({ cancel })],
    ];
    for (const [data, actions] of cases) {
      const view = setup(data, actions);
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      view.unmount();
    }
  });

  it('UI-2 a failed cancel shows the refusal with its prefix', async () => {
    const cancel = vi
      .fn<NonNullable<ChangeSetActions['cancel']>>()
      .mockResolvedValue({ ok: false, message: 'already finished' });
    setup(changeSetModel({ status: 'executing', progress }), actionsWith({ cancel }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Not cancelled: already finished');
  });

  it('UI-4 the result shows written, failed, skipped and drift, and the failed items', async () => {
    const loadItems = vi.fn<ChangeSetActions['loadItems']>().mockResolvedValue({
      ok: true,
      value: { items: [item('sku-9', { status: 'failed', error: 'upstream_rejected' })] },
    });
    setup(
      changeSetModel({ status: 'completed_with_errors', stats: finished, drift: 3, errorCode: 'partial_failure' }),
      actionsWith({ loadItems }),
    );
    await flush();
    const text = document.body.textContent;
    expect(text).toContain('7 written · 2 failed · 1 skipped · 3 changed upstream');
    expect(text).toContain('Error: partial_failure');
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(loadItems).toHaveBeenCalledWith({ status: 'failed' });
    expect(text).toContain('sku-9');
    expect(text).toContain('upstream_rejected');

    loadItems.mockResolvedValue({ ok: true, value: { items: [item('sku-8', { status: 'skipped' })] } });
    fireEvent.click(screen.getByRole('tab', { name: 'Skipped' }));
    await flush();
    expect(loadItems).toHaveBeenCalledTimes(2);
    expect(loadItems).toHaveBeenLastCalledWith({ status: 'skipped' });
    expect(document.body.textContent).toContain('sku-8');

    // Each tab loads on first show only.
    fireEvent.click(screen.getByRole('tab', { name: 'Failed' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Skipped' }));
    await flush();
    expect(loadItems).toHaveBeenCalledTimes(2);
  });

  it('UI-4 the result omits drift and the error line when they are absent', async () => {
    setup(changeSetModel({ status: 'completed', stats: finished }));
    await flush();
    const text = document.body.textContent;
    expect(text).toContain('7 written · 2 failed · 1 skipped');
    expect(text).not.toContain('changed upstream');
    expect(text).not.toContain('Error:');
  });

  it('UI-4 Roll back is absent unless rollback.available and actions.rollback are both given', async () => {
    const rollback = vi.fn<NonNullable<ChangeSetActions['rollback']>>().mockResolvedValue({
      ok: true,
      value: changeSetModel({ status: 'rolling_back' }),
    });
    const done = { status: 'completed', stats: finished };
    const cases: [ChangeSetViewModel, ChangeSetActions][] = [
      [changeSetModel(done), actionsWith()],
      [changeSetModel({ ...done, rollback: { available: true } }), actionsWith()],
      [changeSetModel(done), actionsWith({ rollback })],
    ];
    for (const [data, actions] of cases) {
      const view = setup(data, actions);
      await flush();
      expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
      view.unmount();
    }
    const { onData } = setup(changeSetModel({ ...done, rollback: { available: true } }), actionsWith({ rollback }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await flush();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(changeSetModel({ status: 'rolling_back' }));
  });

  it('UI-4 Roll back N items shows the count and calls the action once', async () => {
    const rollback = vi.fn<NonNullable<ChangeSetActions['rollback']>>().mockResolvedValue({ ok: true, value: undefined });
    const { onData } = setup(
      changeSetModel({ status: 'completed', stats: finished, rollback: { available: true, count: 7, until: '2030-02-01T00:00:00.000Z' } }),
      actionsWith({ rollback }),
    );
    await flush();
    const button = screen.getByRole('button', { name: 'Roll back 7 items' });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(rollback).toHaveBeenCalledTimes(1);
    // A result without a value (the widget opened the page) leaves the view as it is.
    expect(onData).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Roll back 7 items' })).toBeTruthy();
  });

  it('UI-4 a rolled back change-set shows the rollback counts', async () => {
    const { container } = setup(
      changeSetModel({ status: 'rolled_back', stats: finished, rollback: { available: false, stats: { restored: 5, skipped: 1, failed: 2 } } }),
    );
    await flush();
    expect(container.textContent).toContain('5 restored · 1 skipped · 2 failed');
  });

  it('UI-4 rolling_back shows progress with rollback counts', () => {
    const { container } = setup(
      changeSetModel({ status: 'rolling_back', stats: finished, rollback: { available: false, stats: { restored: 3, skipped: 0, failed: 1 } } }),
    );
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(container.textContent).toContain('3 restored · 0 skipped · 1 failed');
  });

  it('SEC-5 an approver comment on a rejected change-set renders as text', () => {
    const { container } = setup(
      changeSetModel({
        status: 'rejected',
        approval: {
          round: 1,
          steps: [
            {
              step: 1,
              role: 'approver',
              decision: {
                decision: 'reject',
                by: 'bob',
                channel: 'page',
                ts: '2030-01-31T13:00:00.000Z',
                comment: '<script>x</script>',
              },
            },
          ],
        },
      }),
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('rejected');
    expect(container.textContent).toContain('<script>x</script>');
  });

  it('UI-2 an expired change-set shows its status without a comment', () => {
    const { container } = setup(changeSetModel({ status: 'expired' }));
    expect(container.querySelector('.status-expired')?.textContent).toBe('expired');
    expect(container.querySelector('.comment')).toBeNull();
  });

  it('UI-2 pending_approval shows the steps and decisions so far', async () => {
    const openPage = vi
      .fn<NonNullable<ChangeSetActions['openPage']>>()
      .mockResolvedValue({ ok: true, value: undefined });
    const { container } = setup(
      changeSetModel({
        status: 'pending_approval',
        approval: {
          round: 2,
          steps: [
            {
              step: 1,
              role: 'editor-lead',
              decision: {
                decision: 'approve',
                by: 'bob',
                channel: 'page',
                ts: '2030-01-31T13:00:00.000Z',
                comment: 'ok',
              },
            },
            { step: 2, role: 'approver' },
          ],
          awaitingRole: 'approver',
        },
      }),
      actionsWith({ openPage }),
    );
    expect(container.querySelector('.status-pending_approval')?.textContent).toBe('pending_approval');
    const text = container.textContent;
    expect(text).toContain('Round 2');
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('editor-lead');
    expect(steps[0]).toContain('approve');
    expect(steps[0]).toContain('bob');
    expect(steps[0]).toContain('ok');
    expect(steps[1]).toContain('approver');
    expect(steps[1]).toContain('waiting');
    expect(text).toContain('Submitted for approval. Approvers decide on the approval page.');
    fireEvent.click(screen.getByRole('button', { name: 'Open as page' }));
    await flush();
    expect(openPage).toHaveBeenCalledTimes(1);
  });

  it('UI-2 pending_approval hides Open as page when the entry does not offer it', () => {
    setup(
      changeSetModel({ status: 'pending_approval', approval: { round: 1, steps: [{ step: 1, role: 'approver' }] } }),
    );
    expect(screen.queryByRole('button', { name: 'Open as page' })).toBeNull();
  });

  it('UI-2 a refresh with the same status keeps the loaded items; a new status loads them again', async () => {
    const loadItems = vi.fn<ChangeSetActions['loadItems']>().mockResolvedValue({
      ok: true,
      value: { items: [item('sku-9', { status: 'failed', error: 'upstream_rejected' })] },
    });
    const actions = actionsWith({ loadItems });
    const onData = vi.fn<(next: ChangeSetViewModel) => void>();
    const shown = (status: string): ReactElement => (
      <ChangeSetView data={changeSetModel({ status, stats: finished })} actions={actions} onData={onData} />
    );
    const { rerender } = render(shown('completed_with_errors'));
    await flush();
    expect(loadItems).toHaveBeenCalledTimes(1);
    rerender(shown('completed_with_errors'));
    await flush();
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('sku-9');
    rerender(shown('rolled_back'));
    await flush();
    expect(loadItems).toHaveBeenCalledTimes(2);
  });

  it('UI-4 the opaque result shows the call outcome and no rollback action', () => {
    const base = {
      status: 'completed_with_errors',
      rollback: { available: true, count: 1 },
      items: { items: [item('call', { status: 'failed', error: 'upstream refused' })] },
    };
    const { container } = setup(opaqueChangeSetModel(base), actionsWith({ rollback: vi.fn() }));
    expect(screen.getByText('Call outcome: failed (upstream refused)')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toContain('"n": 2');
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
    cleanup();
    setup(opaqueChangeSetModel({ status: 'completed', items: { items: [item('call', { status: 'written' })] } }));
    expect(screen.getByText('Call outcome: written')).toBeTruthy();
  });
});
