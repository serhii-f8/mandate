import type { App } from '@modelcontextprotocol/ext-apps';
import { isCallToolResult, type CallToolResult } from '@modelcontextprotocol/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalWidget } from './ApprovalWidget.js';
import { ChangeSetWidget } from './ChangeSetWidget.js';
import type { WidgetApp } from './bridge.js';
import errorTextOnly from './fixtures/error-text-only.json' with { type: 'json' };
import completed from './fixtures/get-changeset-completed.json' with { type: 'json' };
import executing from './fixtures/get-changeset-executing.json' with { type: 'json' };
import getPrepared from './fixtures/get-changeset-prepared.json' with { type: 'json' };
import prepared from './fixtures/prepared.json' with { type: 'json' };
import preparing from './fixtures/preparing.json' with { type: 'json' };
import denied from './fixtures/review-changeset-widget-denied.json' with { type: 'json' };

const A = '0b6f0c2e-8a51-4c2b-9d0e-6f1a2b3c4d5e';
const PAGE_A = `https://aiops.example.test/app/changesets/${A}`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function answer(json: unknown): CallToolResult {
  if (!isCallToolResult(json)) throw new Error('fixture is not a CallToolResult');
  return json;
}

/** A fake host: `get_changeset` answers come from `answers` in order, the last one repeating. */
function fakeApp(answers: CallToolResult[] = []) {
  let next = 0;
  const callServerTool = vi.fn<App['callServerTool']>(() => {
    const result = answers[Math.min(next, answers.length - 1)];
    next += 1;
    return result === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve(result);
  });
  const openLink = vi.fn<App['openLink']>().mockResolvedValue({});
  const updateModelContext = vi.fn<App['updateModelContext']>().mockResolvedValue({});
  const getHostCapabilities = vi.fn<App['getHostCapabilities']>().mockReturnValue({});
  const app: WidgetApp = { callServerTool, openLink, updateModelContext, getHostCapabilities };
  return { app, callServerTool, openLink };
}

/** The unfiltered `get_changeset` calls made with the given page size (polls: 1; full reads: 50). */
function calls(callServerTool: ReturnType<typeof fakeApp>['callServerTool'], pageSize: number): unknown[] {
  return callServerTool.mock.calls.filter(
    ([p]) => p.name === 'get_changeset' && p.arguments?.page_size === pageSize && p.arguments.status === undefined && p.arguments.cursor === undefined,
  );
}

const flush = (): Promise<void> => act(() => Promise.resolve());

/** The prepared answer as it reads while the change-set is still being prepared. */
function stillPreparing(): CallToolResult {
  const base = answer(getPrepared);
  const sc = getPrepared.structuredContent;
  return { ...base, structuredContent: { ...sc, changeset: { ...sc.changeset, status: 'preparing' }, items: [] } };
}

describe('ChangeSetWidget', () => {
  it('UI-3 the change-set widget renders the preview from a prepared result', () => {
    const { app } = fakeApp();
    const { rerender } = render(<ChangeSetWidget app={app} trigger={undefined} tornDown={false} />);
    expect(document.body.textContent).toContain('Waiting for data…');
    rerender(<ChangeSetWidget app={app} trigger={answer(prepared)} tornDown={false} />);
    expect(screen.getByRole('button', { name: 'Submit 2 changes' })).toBeTruthy();
    expect(document.body.textContent).toContain('UMBRELLA-0001');
  });

  it('UI-2 a result with only an ID loads the change-set with get_changeset', async () => {
    const { app, callServerTool } = fakeApp([answer(getPrepared)]);
    render(<ChangeSetWidget app={app} trigger={answer(preparing)} tornDown={false} />);
    expect(document.body.textContent).toContain('Loading…');
    await flush();
    expect(callServerTool.mock.calls).toEqual([[{ name: 'get_changeset', arguments: { changeset_id: A, page_size: 50 } }]]);
    expect(screen.getByRole('button', { name: 'Submit 2 changes' })).toBeTruthy();
  });

  it('UI-1 a failed load shows its text and an Open as page button', async () => {
    const { app } = fakeApp([answer(errorTextOnly)]);
    render(<ChangeSetWidget app={app} trigger={answer(preparing)} tornDown={false} />);
    await flush();
    expect(document.body.textContent).toContain(`Change-set ${A} was not found.`);
    expect(screen.getByRole('button', { name: 'Open as page' })).toBeTruthy();
  });

  it('UI-1 an unparsable result shows its text and an Open as page button', async () => {
    const { app, callServerTool, openLink } = fakeApp();
    const odd: CallToolResult = {
      content: [{ type: 'text', text: 'Something unexpected.' }, { type: 'text', text: 'second block' }],
      structuredContent: { changeset: { id: 42 }, pageUrl: PAGE_A },
    };
    render(<ChangeSetWidget app={app} trigger={odd} tornDown={false} />);
    expect(document.body.textContent).toContain('Something unexpected.');
    expect(document.body.textContent).not.toContain('second block');
    fireEvent.click(screen.getByRole('button', { name: 'Open as page' }));
    await flush();
    expect(openLink).toHaveBeenCalledWith({ url: PAGE_A });
    expect(callServerTool).not.toHaveBeenCalled();

    // Without a page address: the text alone, never a blank frame.
    cleanup();
    render(<ChangeSetWidget app={app} trigger={answer(errorTextOnly)} tornDown={false} />);
    expect(document.body.textContent).toContain(`Change-set ${A} was not found.`);
    expect(screen.queryByRole('button', { name: 'Open as page' })).toBeNull();
  });

  it('UI-1 a bridge error shows only the connection message', () => {
    render(<ChangeSetWidget app={null} trigger={answer(prepared)} tornDown={false} error={new Error('no host')} />);
    expect(document.body.textContent).toBe('The widget could not connect to the host.');
  });

  it('UI-2 the widget polls get_changeset with page_size 1 while executing and stops on teardown', async () => {
    vi.useFakeTimers();
    const { app, callServerTool } = fakeApp([answer(executing)]);
    const { rerender } = render(<ChangeSetWidget app={app} trigger={answer(executing)} tornDown={false} />);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls(callServerTool, 1)).toEqual([[{ name: 'get_changeset', arguments: { changeset_id: A, page_size: 1 } }]]);
    // The same status keeps the progress view.
    expect(screen.getByRole('progressbar')).toBeTruthy();

    rerender(<ChangeSetWidget app={app} trigger={answer(executing)} tornDown />);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(calls(callServerTool, 1)).toHaveLength(1);
  });

  it('UI-2 polling stops once the status is terminal', async () => {
    vi.useFakeTimers();
    const { app, callServerTool } = fakeApp([answer(completed)]);
    render(<ChangeSetWidget app={app} trigger={answer(executing)} tornDown={false} />);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls(callServerTool, 1)).toHaveLength(1);
    // A new status: one full refresh, then the result view.
    expect(calls(callServerTool, 50)).toHaveLength(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.body.textContent).toContain('written');
    const made = callServerTool.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(callServerTool.mock.calls).toHaveLength(made);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('UI-2 a change-set that finishes preparing shows its items', async () => {
    vi.useFakeTimers();
    const { app, callServerTool } = fakeApp([stillPreparing(), answer(getPrepared)]);
    render(<ChangeSetWidget app={app} trigger={answer(preparing)} tornDown={false} />);
    await flush();
    expect(document.body.textContent).toContain('Being prepared…');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls(callServerTool, 1)).toHaveLength(1);
    expect(calls(callServerTool, 50)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Submit 2 changes' })).toBeTruthy();
    expect(document.body.textContent).toContain('UMBRELLA-0001');
  });

  it('UI-2 a stopped schedule offers Refresh, which polls again', async () => {
    vi.useFakeTimers();
    const { app, callServerTool } = fakeApp([answer(executing)]);
    render(<ChangeSetWidget app={app} trigger={answer(executing)} tornDown={false} />);
    await act(() => vi.advanceTimersByTimeAsync(1_800_000 + 10_000));
    const polled = calls(callServerTool, 1).length;
    expect(polled).toBeLessThanOrEqual(200);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls(callServerTool, 1)).toHaveLength(polled + 1);
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });
});

describe('ApprovalWidget', () => {
  it('APR-8 the approval widget for a role without allow_widget shows no decision buttons and offers the approval page', async () => {
    const { app, callServerTool, openLink } = fakeApp();
    render(<ApprovalWidget app={app} trigger={answer(denied)} />);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decide on the approval page' }));
    await flush();
    expect(openLink).toHaveBeenCalledWith({ url: PAGE_A });
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it('UI-1 the approval widget shows an unparsable result as text with the page link', () => {
    const { app } = fakeApp();
    render(<ApprovalWidget app={app} trigger={{ content: [{ type: 'text', text: 'Not reviewable.' }], structuredContent: { pageUrl: PAGE_A } }} />);
    expect(document.body.textContent).toContain('Not reviewable.');
    expect(screen.getByRole('button', { name: 'Open as page' })).toBeTruthy();
  });
});
