// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigurationState, ConfigurationStateSource } from '@mandate/config';
import { configurationGate } from './configuration-gate.js';

const ACTIVE: ConfigurationState = { status: 'active', revision: '00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64) };
const NONE: ConfigurationState = { status: 'none' };
const MISMATCH: ConfigurationState = { status: 'configuration_mismatch', revision: '00000000-0000-4000-8000-000000000002' };

function source(state: ConfigurationState): ConfigurationStateSource {
  return { state: () => state };
}

function request(method: string, path: string): Request {
  return { method, path } as unknown as Request;
}

function capture(): { res: Response; sent: { status?: number; body?: unknown; headers: Record<string, string> } } {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    set(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

describe('CFG-2 SEC-1 configuration gate', () => {
  it('passes every request while a configuration is active', () => {
    const gate = configurationGate(source(ACTIVE));
    for (const [method, path] of [
      ['POST', '/mcp'],
      ['GET', '/api/v1/changesets/x'],
      ['GET', '/app/'],
      ['GET', '/healthz'],
    ] as const) {
      const { res, sent } = capture();
      const next = vi.fn();
      gate(request(method, path), res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
      expect(sent).toEqual({ headers: {} });
    }
  });

  it.each([
    ['none', NONE],
    ['configuration_mismatch', MISMATCH],
  ])('answers 503 configuration_unavailable with no-store when none is active (%s)', (_name, state) => {
    const gate = configurationGate(source(state));
    for (const [method, path] of [
      ['POST', '/mcp'],
      ['GET', '/api/v1/changesets/x'],
      ['GET', '/app/'],
    ] as const) {
      const { res, sent } = capture();
      const next = vi.fn();
      gate(request(method, path), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(sent).toEqual({ status: 503, body: { error: 'configuration_unavailable' }, headers: { 'cache-control': 'no-store' } });
    }
  });

  it('lets GET /healthz, /readyz and /metrics through in every state', () => {
    for (const state of [ACTIVE, NONE, MISMATCH]) {
      const gate = configurationGate(source(state));
      for (const path of ['/healthz', '/readyz', '/metrics']) {
        const { res, sent } = capture();
        const next = vi.fn();
        gate(request('GET', path), res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(sent).toEqual({ headers: {} });
      }
    }
  });

  it('does not exempt POST /healthz or /readyz/x', () => {
    const gate = configurationGate(source(NONE));
    for (const [method, path] of [
      ['POST', '/healthz'],
      ['GET', '/readyz/x'],
      ['GET', '/healthz/'],
      ['DELETE', '/metrics'],
    ] as const) {
      const { res, sent } = capture();
      const next = vi.fn();
      gate(request(method, path), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(sent.status).toBe(503);
    }
  });

  it('reads the state on every request, so a configuration that becomes active is served at once', () => {
    let state: ConfigurationState = NONE;
    const gate = configurationGate({ state: () => state });
    const first = capture();
    gate(request('POST', '/mcp'), first.res, vi.fn());
    expect(first.sent.status).toBe(503);
    state = ACTIVE;
    const next = vi.fn();
    gate(request('POST', '/mcp'), capture().res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
