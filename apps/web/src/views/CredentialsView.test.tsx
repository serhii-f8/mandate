// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsView, type ConnectionTestReport, type CredentialRow, type SaveResult } from './CredentialsView.js';

afterEach(cleanup);

const FIELDS: Record<string, readonly string[]> = { basic: ['username', 'password'], bearer: ['token'], webhook_url: ['url'] };
const fields = (scheme: string): readonly string[] => FIELDS[scheme] ?? [];

const row = (over: Partial<CredentialRow> = {}): CredentialRow => ({ ref: 'shop-token', scheme: 'bearer', connections: ['shop'], notifications: [], set: false, ...over });

const FRESH_LOGIN = '/auth/login?return_to=/app/credentials&fresh=1';

function setup(
  rows: CredentialRow[],
  props: { onSave?: (ref: string, secret: Record<string, string>) => Promise<SaveResult>; onTest?: (c: string) => Promise<ConnectionTestReport>; fresh?: boolean } = {},
) {
  const onSave = props.onSave ?? vi.fn<(ref: string, secret: Record<string, string>) => Promise<SaveResult>>().mockResolvedValue('saved');
  const onTest = props.onTest ?? vi.fn<(c: string) => Promise<ConnectionTestReport>>();
  const view = render(<CredentialsView credentials={rows} onSave={onSave} onTest={onTest} fields={fields} fresh={props.fresh ?? true} freshLoginUrl={FRESH_LOGIN} />);
  return { ...view, onSave, onTest };
}

describe('SEC-8 UI-5 the page asks for a fresh login before a secret is typed', () => {
  it('SEC-8 UI-5 a session that is not fresh shows "Log in again to change credentials" and no usable secret input', () => {
    const { onSave } = setup([row()], { fresh: false });
    const action = screen.getByRole('link', { name: /log in again to change credentials/i });
    expect(action.getAttribute('href')).toBe(FRESH_LOGIN);
    expect(screen.getByLabelText<HTMLInputElement>('token').disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /save/i }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    // The connection test needs no fresh login.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /test shop/i }).disabled).toBe(false);
  });

  it('SEC-8 UI-5 a fresh session shows the form usable and no re-login action', () => {
    setup([row()], { fresh: true });
    expect(screen.queryByRole('link', { name: /log in again/i })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('token').disabled).toBe(false);
  });
});

describe('UI-5 credential entry view', () => {
  it('UI-5 SEC-2 a webhook credential lists its notifications and offers no connection test', () => {
    setup([row({ ref: 'ops-chat-webhook', scheme: 'webhook_url', connections: [], notifications: ['ops-chat'] })]);
    expect(screen.getByLabelText<HTMLInputElement>('url').type).toBe('password');
    expect(screen.getByText('ops-chat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^test /i })).toBeNull();
    expect(screen.queryByText('Connections')).toBeNull();
  });

  it('UI-5 renders refs with their status and never a secret value', () => {
    setup([row({ set: true, updatedAt: '2026-01-02T03:04:05.000Z', updatedBy: 'carol', keyVersion: 1 }), row({ ref: 'erp', scheme: 'basic', connections: ['erp'] })]);
    expect(screen.getByText('shop-token')).toBeTruthy();
    expect(screen.getByText(/set\b/i, { selector: '[data-status="set"]' })).toBeTruthy();
    expect(screen.getByText(/not set/i, { selector: '[data-status="unset"]' })).toBeTruthy();
    expect(screen.getByText(/carol/)).toBeTruthy();
  });

  it('UI-5 form fields follow the scheme and secret inputs are password inputs without autocomplete', () => {
    setup([row({ ref: 'erp', scheme: 'basic', connections: ['erp'] })]);
    const user = screen.getByLabelText<HTMLInputElement>('username');
    const pass = screen.getByLabelText<HTMLInputElement>('password');
    expect(user.type).toBe('text');
    expect(pass.type).toBe('password');
    expect(pass.getAttribute('autocomplete')).toBe('off');
    expect(user.getAttribute('autocomplete')).toBe('off');
  });

  it('UI-5 sends the secret once and the inputs are empty afterwards', async () => {
    const { onSave } = setup([row()]);
    const token = screen.getByLabelText<HTMLInputElement>('token');
    fireEvent.change(token, { target: { value: 'fake-token-value' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeTruthy();
    });
    expect(onSave).toHaveBeenCalledWith('shop-token', { token: 'fake-token-value' });
    expect(token.value).toBe('');
    expect(document.body.textContent).not.toContain('fake-token-value');
  });

  it('UI-5 shows field names of a rejected secret and keeps no value', async () => {
    const { onSave } = setup([row()], { onSave: vi.fn().mockResolvedValue({ error: 'invalid_secret: token' }) });
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('invalid_secret: token');
    });
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('UI-5 asks for a fresh login when the save needs reauthentication', async () => {
    setup([row()], { onSave: vi.fn().mockResolvedValue('reauthentication_required') });
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/log in again/i);
    });
  });

  it('UI-5 CONN-7 the test button shows ok and the scope report', async () => {
    const report: ConnectionTestReport = { ok: true, operation: 'listProducts', status: 200, durationMs: 12, itemCount: 2, scopes: { detectable: true, source: 'token-introspection', values: ['read', 'catalog'] } };
    const onTest = vi.fn().mockResolvedValue(report);
    setup([row()], { onTest });
    fireEvent.click(screen.getByRole('button', { name: /test shop/i }));
    await waitFor(() => {
      expect(document.querySelector('[data-test-result]')?.textContent).toMatch(/^ok/);
    });
    expect(onTest).toHaveBeenCalledWith('shop');
    expect(screen.getByText(/read, catalog/)).toBeTruthy();
  });

  it('UI-5 CONN-7 a failed test shows its code and message', async () => {
    setup([row()], { onTest: vi.fn().mockResolvedValue({ ok: false, operation: 'listProducts', durationMs: 3, code: 'upstream_unauthorized', message: 'rejected', scopes: { detectable: false, source: 'none', values: [] } }) });
    fireEvent.click(screen.getByRole('button', { name: /test shop/i }));
    await waitFor(() => {
      expect(screen.getByText(/upstream_unauthorized/)).toBeTruthy();
    });
  });
});

describe('SEC-5 page text is escaped', () => {
  it('SEC-5 a connection name with markup is rendered as text, not as an element', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = setup([row({ connections: [evil] })]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
  });

  it('SEC-5 a ref and an error message with markup stay text', async () => {
    const evil = '<script>alert(1)</script>';
    const { container } = setup([row({ ref: evil })], { onSave: vi.fn().mockResolvedValue({ error: evil }) });
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(evil);
    });
    expect(container.querySelector('script')).toBeNull();
  });
});
