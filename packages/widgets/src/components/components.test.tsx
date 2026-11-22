// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemRowModel } from '../model.js';
import { ItemTable } from './ItemTable.js';
import { Notice } from './Notice.js';
import { Pager } from './Pager.js';
import { RawArguments } from './RawArguments.js';
import { StatsSummary } from './StatsSummary.js';

afterEach(cleanup);

const row = (over: Partial<ItemRowModel>): ItemRowModel => ({
  targetId: 'SKU-1',
  status: 'pending',
  before: 'a',
  after: 'b',
  ...over,
});

describe('components', () => {
  it('SEC-5 hostile values render as text in the item table', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(<ItemTable rows={[row({ before: hostile })]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
  });

  it('UI-3 the item table shows one row per changed field with before and after', () => {
    const { container } = render(
      <ItemTable
        rows={[
          row({
            before: { price: 1, name: 'x' },
            after: { price: 2, name: 'y' },
          }),
        ]}
      />,
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByText('price')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr:first-child td[rowspan="2"]')).toHaveLength(2);
  });

  it('APR-6 a create change-set shows a dash in every before cell and a new badge', () => {
    const { container } = render(
      <ItemTable action="create" rows={[row({ before: null, after: { name: 'x', price: 2 } })]} />,
    );
    expect([...container.querySelectorAll('td.before')].map((c) => c.textContent)).toEqual(['—', '—']);
    expect([...container.querySelectorAll('td.after')].map((c) => c.textContent)).toEqual(['x', '2']);
    expect(container.querySelector('.action-badge')?.textContent).toBe('new');
  });

  it('APR-6 a delete change-set shows a dash in every after cell and a delete badge', () => {
    const { container } = render(
      <ItemTable action="delete" rows={[row({ before: { name: 'x', price: 2 }, after: null })]} />,
    );
    expect([...container.querySelectorAll('td.after')].map((c) => c.textContent)).toEqual(['—', '—']);
    expect([...container.querySelectorAll('td.before')].map((c) => c.textContent)).toEqual(['x', '2']);
    expect(container.querySelector('.action-badge')?.textContent).toBe('delete');
  });

  it('APR-6 the badge follows the action: an excluded already_exists item of a create carries new', () => {
    const { container } = render(
      <ItemTable action="create" rows={[row({ status: 'excluded', reason: 'already_exists', before: { name: 'old' }, after: { name: 'x' } })]} />,
    );
    expect(container.querySelector('.action-badge')?.textContent).toBe('new');
  });

  it('APR-6 an update change-set item with null sides shows dashes and no badge', () => {
    const { container } = render(
      <>
        <ItemTable rows={[row({ before: null, after: null })]} />
        <ItemTable action="update" rows={[row({ status: 'excluded', reason: 'not_found', before: null, after: null })]} />
      </>,
    );
    expect(container.querySelector('.action-badge')).toBeNull();
    expect(container.querySelector('td.before')?.textContent).toBe('—');
    expect(container.querySelector('td.after')?.textContent).toBe('—');
  });

  it('APR-6 an update row has no action badge and no dash', () => {
    const { container } = render(<ItemTable rows={[row({ before: { name: 'a' }, after: { name: 'b' } })]} />);
    expect(container.querySelector('.action-badge')).toBeNull();
    expect(container.textContent).not.toContain('—');
  });

  it('UI-3 an excluded item shows its reason', () => {
    const { container } = render(<ItemTable rows={[row({ status: 'excluded', reason: 'no_change' })]} />);
    expect(screen.getByText('excluded: no_change')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('UI-3 a failed item shows its error code', () => {
    render(<ItemTable rows={[row({ status: 'failed', error: 'UPSTREAM_REJECTED' })]} />);
    expect(screen.getByText('UPSTREAM_REJECTED')).toBeTruthy();
  });

  it('UI-3 checkboxes appear only where canSelect allows and call toggle', () => {
    const toggle = vi.fn();
    render(
      <ItemTable
        rows={[row({ targetId: 'A' }), row({ targetId: 'B' })]}
        selection={{
          selected: new Set(['A']),
          canSelect: (r) => r.targetId === 'A',
          toggle,
        }}
      />,
    );
    expect(screen.queryByLabelText('Select B')).toBeNull();
    const box = screen.getByLabelText<HTMLInputElement>('Select A');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(toggle).toHaveBeenCalledWith('A');
  });

  it('UI-3 StatsSummary states included, excluded per reason, hash and expiry', () => {
    const hash = `sha256:6114edb2${'0'.repeat(48)}`;
    const { container } = render(
      <StatsSummary
        stats={{
          total: 4,
          included: 3,
          excluded: { no_change: 1 },
          written: 0,
          failed: 0,
          skipped: 0,
        }}
        hash={hash}
        expiresAt="2026-01-02T10:00:00Z"
      />,
    );
    expect(container.textContent).toContain('3 changes · 1 excluded (no_change 1)');
    expect(container.textContent).toContain('sha256:6114edb2…');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(hash);
    expect(container.textContent).toContain('Expires ');
  });

  it('UI-6 Notice uses role alert for errors and status for info', () => {
    render(
      <>
        <Notice kind="error">bad</Notice>
        <Notice kind="info">fine</Notice>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('bad');
    expect(screen.getByRole('status').textContent).toBe('fine');
  });
});

describe('pager', () => {
  it('NFR-8 Pager disables buttons without a page or while busy and calls the handlers', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <Pager hasPrevious={false} hasNext busy={false} onPrevious={onPrevious} onNext={onNext} />,
    );
    expect(screen.getByText<HTMLButtonElement>('Previous').disabled).toBe(true);
    fireEvent.click(screen.getByText('Next'));
    expect(onNext).toHaveBeenCalledTimes(1);
    rerender(<Pager hasPrevious hasNext={false} busy={false} onPrevious={onPrevious} onNext={onNext} />);
    expect(screen.getByText<HTMLButtonElement>('Next').disabled).toBe(true);
    fireEvent.click(screen.getByText('Previous'));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    rerender(<Pager hasPrevious hasNext busy onPrevious={onPrevious} onNext={onNext} />);
    expect(screen.getByText<HTMLButtonElement>('Next').disabled).toBe(true);
    expect(screen.getByText<HTMLButtonElement>('Previous').disabled).toBe(true);
  });

  it('APR-5 SEC-5 raw arguments show invisible, bidi and control characters as visible escapes', () => {
    // RLO reverses what follows; a zero-width space and NUL are invisible; a tag character smuggles ASCII.
    const hostile = `pay\u202Eevil\u200Bx\u0000y\u{E0041}z\u2066`;
    const { container } = render(<RawArguments args={{ to: hostile, plain: 'café ok' }} />);
    const pre = container.querySelector('pre');
    const text = pre?.textContent ?? '';
    for (const c of ['\u202E', '\u200B', '\u0000', '\u{E0041}', '\u2066']) expect(text).not.toContain(c);
    expect(text).toContain('"pay\\u202Eevil\\u200Bx\\u0000y\\u{E0041}z\\u2066"');
    // The escapes are marked so the approver can tell them from typed text.
    const marked = [...(pre?.querySelectorAll('.invisible-char') ?? [])].map((e) => e.textContent);
    expect(marked).toEqual(['\\u202E', '\\u200B', '\\u{E0041}', '\\u2066']);
    expect(pre?.querySelector('.invisible-char')?.getAttribute('title')).toBe('U+202E');
    // Ordinary text, the layout's newlines and indentation are unchanged.
    expect(text).toContain('"plain": "café ok"');
    expect(text.split('\n')).toHaveLength(4);
    expect(container.querySelector('img')).toBeNull();
  });
});
