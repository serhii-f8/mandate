// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigurationState } from '@mandate/config';
import { uploadGate } from './upload-gate.js';

function run(options: { url?: string; method?: string; headers?: Record<string, string>; status?: ConfigurationState['status']; maxBytes?: number; secure?: boolean }) {
  let maxBytes = options.maxBytes ?? 100;
  const gate = uploadGate({
    isUpload: (req) => req.method === 'POST' && req.url === '/api/v1/files',
    configuration: {
      state: () => ({ status: options.status ?? 'active', revision: 'r' }) as ConfigurationState,
      get current() {
        return { files: { maxBytes } } as never;
      },
    },
    secureCookie: options.secure ?? false,
  });
  const answered: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      answered.status = code;
      return this;
    },
    json(body: unknown) {
      answered.body = body;
      return this;
    },
  } as unknown as Response;
  const next = vi.fn<() => void>();
  const req = { method: options.method ?? 'POST', url: options.url ?? '/api/v1/files', headers: options.headers ?? {} } as unknown as Request;
  gate(req, res, next);
  const setMax = (n: number): void => {
    maxBytes = n;
  };
  const again = (): void => {
    gate(req, res, next);
  };
  return { answered, next, setMax, again };
}

describe('CS-10 SEC-1 early refusals of an upload', () => {
  it('SEC-1 no session cookie is 401 unauthenticated; the __Host- cookie is required on https', () => {
    expect(run({}).answered).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(run({ headers: { cookie: 'mandate_session=x' }, secure: true }).answered).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(run({ headers: { cookie: '__Host-mandate_session=x' }, secure: true }).next).toHaveBeenCalledOnce();
  });

  it('CS-10 a Content-Length above the current files.max_bytes is 413; at the limit or without one it passes', () => {
    const cookie = 'mandate_session=x';
    expect(run({ headers: { cookie, 'content-length': '101' } }).answered).toEqual({ status: 413, body: { error: 'payload_too_large' } });
    expect(run({ headers: { cookie, 'content-length': '100' } }).next).toHaveBeenCalledOnce();
    expect(run({ headers: { cookie } }).next).toHaveBeenCalledOnce();
    // Read per request: a reload that raises the limit applies to the next upload.
    const raised = run({ headers: { cookie, 'content-length': '101' } });
    raised.setMax(200);
    raised.again();
    expect(raised.next).toHaveBeenCalledOnce();
  });

  it('CFG-2 other routes, and any request while no configuration is active, pass on untouched', () => {
    expect(run({ url: '/api/v1/changesets' }).next).toHaveBeenCalledOnce();
    expect(run({ method: 'GET' }).next).toHaveBeenCalledOnce();
    expect(run({ status: 'none' }).next).toHaveBeenCalledOnce();
  });
});
