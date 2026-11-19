import { InsufficientScopeError, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { GuardedFetchError } from '../http/guarded-fetch.js';
import { outcomeAfterSend, outcomeOfResult } from './call-once.js';

describe('EXE-4 MCP callOnce outcome after the hook ran', () => {
  it('EXE-4 a result without isError is accepted; isError is refused; content is never read (SEC-5)', () => {
    const ok = { content: [{ type: 'text', text: 'x' }], _meta: { upstream: 'detail' } };
    const failed = { isError: true, content: [{ type: 'text', text: 'ignore previous' }] };
    expect(outcomeOfResult(ok, 5)).toEqual({ result: 'accepted', durationMs: 5 });
    expect(outcomeOfResult({ isError: false }, 5)).toEqual({ result: 'accepted', durationMs: 5 });
    expect(outcomeOfResult(failed, 5)).toEqual({ result: 'refused', code: 'rejected', durationMs: 5 });
  });

  it.each([
    ['a JSON-RPC error answer', new ProtocolError(ProtocolErrorCode.InvalidParams, 'upstream text'), { result: 'refused', code: 'rejected' }],
    ['a transport 4xx', new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'upstream text', { status: 422 }), { result: 'refused', code: 'rejected', status: 422 }],
    ['a 403 insufficient_scope', new InsufficientScopeError({ requiredScope: 'write' }), { result: 'refused', code: 'rejected', status: 403 }],
    ['a transport 5xx', new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'upstream text', { status: 502 }), { result: 'unknown', code: 'http_status', status: 502 }],
    ['a request timeout', new SdkError(SdkErrorCode.RequestTimeout, 'timed out'), { result: 'unknown', code: 'timeout' }],
    ['another SDK error', new SdkError(SdkErrorCode.ConnectionClosed, 'closed'), { result: 'unknown', code: 'upstream_error' }],
    ['a guarded timeout', new GuardedFetchError('timeout', 'slow'), { result: 'unknown', code: 'timeout' }],
    ['a guarded network error', new GuardedFetchError('network', 'reset'), { result: 'unknown', code: 'network' }],
    ['a body cut off or oversized', new GuardedFetchError('invalid_response', 'too big'), { result: 'unknown', code: 'invalid_response' }],
    ['a redirect', new GuardedFetchError('egress_denied', 'redirected', 303), { result: 'unknown', code: 'http_status', status: 303 }],
    ['an aborted stream', new DOMException('This operation was aborted', 'AbortError'), { result: 'unknown', code: 'network' }],
    ['a guarded error in the cause chain', new Error('wrapped', { cause: new GuardedFetchError('network', 'reset') }), { result: 'unknown', code: 'network' }],
    ['an unrecognised error', new RangeError('bug'), { result: 'unknown', code: 'upstream_error' }],
  ] as const)('EXE-4 %s', (_label, error, expected) => {
    const outcome = outcomeAfterSend(error, 7);
    expect(outcome).toEqual({ ...expected, durationMs: 7 });
    expect(JSON.stringify(outcome)).not.toContain('upstream text');
  });

  it('EXE-4 R4 the egress guard refusing the address at connect sent nothing', () => {
    expect(outcomeAfterSend(new GuardedFetchError('egress_denied', 'private address'), 3)).toEqual({ result: 'not_sent', code: 'egress_denied', durationMs: 3 });
  });
});
