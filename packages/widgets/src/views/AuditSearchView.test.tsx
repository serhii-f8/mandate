import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditSearchView, type AuditEventModel } from './AuditSearchView.js';

afterEach(cleanup);

const event = (over: Partial<AuditEventModel> = {}): AuditEventModel => ({
  seq: '1',
  ts: '2030-01-01T00:00:00.000000Z',
  actor: 'alice',
  action: 'tool.call',
  outcome: 'ok',
  subject: 'ping',
  changesetId: null,
  correlationId: 'corr-1',
  chainPos: 7,
  details: {},
  ...over,
});

describe('AuditSearchView', () => {
  it('UI-2 renders events with details as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(<AuditSearchView events={[event({ details: { note: hostile } })]} filters={{}} exportUrl="/x" onSearch={() => undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain(hostile);
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('UI-2 the form submits the entered filters', () => {
    const onSearch = vi.fn();
    render(<AuditSearchView events={[]} filters={{ actor: 'bob' }} exportUrl="/x" onSearch={onSearch} />);
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'tool.call' } });
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'denied' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledWith({ actor: 'bob', action: 'tool.call', outcome: 'denied' });
  });

  it('UI-2 shows unsealed for a row without chainPos and More only with onMore', () => {
    const rows = [event({ seq: '2', chainPos: null }), event({ seq: '1', chainPos: 7 })];
    const { rerender } = render(<AuditSearchView events={rows} filters={{}} exportUrl="/x" onSearch={() => undefined} />);
    const body = screen.getAllByRole('row').slice(1);
    expect(within(body[0] ?? document.body).getByText('unsealed')).toBeTruthy();
    expect(within(body[1] ?? document.body).getByText('7')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    const onMore = vi.fn();
    rerender(<AuditSearchView events={rows} filters={{}} exportUrl="/x" onSearch={() => undefined} onMore={onMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onMore).toHaveBeenCalled();
  });

  it('UI-2 the export link carries the current filters', () => {
    render(<AuditSearchView events={[]} filters={{}} exportUrl="/api/v1/audit/export?actor=bob" onSearch={() => undefined} error="Check the filter values." />);
    expect(screen.getByRole('link', { name: 'Export JSON Lines' }).getAttribute('href')).toBe('/api/v1/audit/export?actor=bob');
    expect(screen.getByRole('alert').textContent).toBe('Check the filter values.');
  });
});
