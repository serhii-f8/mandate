import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { bodyErrorHandler } from './body-errors.js';

function capture(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

// The handler never reads the request.
const request = Object.create(null) as Request;

const parseError = (type: string, status: number) => Object.assign(new Error(`Unexpected token in {"token":SUPERSECRET123}`), { type, status, body: '{"token":SUPERSECRET123}' });

describe('SEC-3 body parser errors get fixed bodies', () => {
  it.each([
    ['entity.parse.failed', 400, 400, { error: 'invalid_json' }],
    ['entity.too.large', 413, 413, { error: 'payload_too_large' }],
    ['encoding.unsupported', 415, 415, { error: 'invalid_body' }],
    ['request.aborted', 400, 400, { error: 'invalid_body' }],
  ])('SEC-3 %s answers %i with a fixed body', (type, status, expected, body) => {
    const { res, sent } = capture();
    const next = vi.fn();
    bodyErrorHandler(parseError(type, status), request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(sent).toEqual({ status: expected, body });
    expect(JSON.stringify(sent)).not.toContain('SUPERSECRET123');
  });

  it('SEC-3 other errors pass on', () => {
    const { res, sent } = capture();
    const next = vi.fn();
    const error = new Error('something else');
    bodyErrorHandler(error, request, res, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(sent).toEqual({});
  });
});
