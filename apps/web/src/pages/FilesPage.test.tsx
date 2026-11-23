// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesPage } from './FilesPage.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = { subject: 's', roles: [], csrfToken: 'tok', authTime: '2030-01-01T00:00:00.000Z', fresh: true, expiresAt: '2030-01-01T08:00:00.000Z', viewAudit: false };
const ID = '33333333-3333-4333-8333-333333333333';
const view = (id: string, name: string) => ({ id, name, mediaType: 'image/png', size: 2048, sha256: `sha256:${'a'.repeat(64)}`, preview: 'image', createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-02T00:00:00.000Z' });

interface Answer {
  status: number;
  body: unknown;
}
function stub(list: Answer, upload?: Answer) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? 'GET'} ${url}`;
    const a: Answer = key === 'GET /api/v1/session' ? { status: 200, body: session } : key === 'GET /api/v1/files' ? list : key === 'POST /api/v1/files' && upload ? upload : { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** The init of every POST the page sent. */
function posts(mock: ReturnType<typeof stub>): RequestInit[] {
  return mock.mock.calls.flatMap(([, init]) => (init?.method === 'POST' ? [init] : []));
}

function choose(file: File): void {
  fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
}

describe('UI-2 the files page', () => {
  it('UI-2 lists the own files with their ID', async () => {
    stub({ status: 200, body: [view(ID, 'logo.png')] });
    render(<FilesPage />);
    await screen.findByText('logo.png');
    expect(screen.getByText(ID)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeTruthy();
  });

  it('UI-2 pressing Upload sends the raw File with the name, type and CSRF headers, and a 201 adds the file', async () => {
    const mock = stub({ status: 200, body: [] }, { status: 201, body: view(ID, 'Ünï cödé.png') });
    render(<FilesPage />);
    await screen.findByLabelText('File');
    const file = new File(['abc'], 'Ünï cödé.png', { type: 'image/png' });
    choose(file);
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(ID);
    const sent = posts(mock);
    expect(sent.length).toBe(1);
    expect(sent[0]?.body).toBe(file);
    const headers = new Headers(sent[0]?.headers);
    expect(headers.get('x-file-name')).toBe(encodeURIComponent('Ünï cödé.png'));
    expect(headers.get('content-type')).toBe('image/png');
    expect(headers.get('x-csrf-token')).toBe('tok');
  });

  it('UI-2 a file without a type goes as application/octet-stream', async () => {
    const mock = stub({ status: 200, body: [] }, { status: 201, body: view(ID, 'a.bin') });
    render(<FilesPage />);
    await screen.findByLabelText('File');
    choose(new File(['abc'], 'a.bin'));
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(ID);
    expect(new Headers(posts(mock)[0]?.headers).get('content-type')).toBe('application/octet-stream');
  });

  const REFUSALS: [number, string, string][] = [
    [403, 'forbidden', 'Your roles have no operation that takes a file.'],
    [413, 'payload_too_large', 'The file is larger than the platform allows.'],
    [409, 'quota_exceeded', 'You have reached your limit of staged files. They expire by themselves, or use them in a change.'],
    [400, 'empty_file', 'The file is empty.'],
    [400, 'invalid_name', 'The file name is not allowed.'],
    [400, 'invalid_media_type', 'The file type could not be read.'],
  ];
  for (const [status, code, text] of REFUSALS) {
    it(`UI-2 the refusal ${code} shows its sentence`, async () => {
      stub({ status: 200, body: [] }, { status, body: { error: code } });
      render(<FilesPage />);
      await screen.findByLabelText('File');
      choose(new File(['abc'], 'a.png', { type: 'image/png' }));
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
      await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(text); });
    });
  }

  it('UI-2 an unknown refusal shows the generic text', async () => {
    stub({ status: 200, body: [] }, { status: 415, body: { error: 'invalid_body' } });
    render(<FilesPage />);
    await screen.findByLabelText('File');
    choose(new File(['abc'], 'a.png', { type: 'image/png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Not uploaded: invalid_body'); });
  });

  it('UI-2 a 403 on load shows the forbidden sentence and no form', async () => {
    stub({ status: 403, body: { error: 'forbidden' } });
    render(<FilesPage />);
    await screen.findByText('Your roles have no operation that takes a file.');
    expect(screen.queryByLabelText('File')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });
});
