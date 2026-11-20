import { describe, expect, it } from 'vitest';
import { rateLimitedBody, rateLimitUnavailableBody, requestId } from './rate-limit-answer.js';

describe('SEC-10 rate limit answers of the MCP endpoint', () => {
  it('SEC-10 requestId takes a string or number id and null otherwise', () => {
    expect(requestId({ id: 7 })).toBe(7);
    expect(requestId({ id: 'a' })).toBe('a');
    expect(requestId({ id: {} })).toBeNull();
    expect(requestId({ id: null })).toBeNull();
    expect(requestId({})).toBeNull();
    expect(requestId([])).toBeNull();
    expect(requestId([{ id: 1 }])).toBeNull();
    expect(requestId('text')).toBeNull();
    expect(requestId(null)).toBeNull();
    expect(requestId(undefined)).toBeNull();
  });

  it('SEC-10 the 429 body is the JSON-RPC rate_limited error with the request id', () => {
    expect(JSON.stringify(rateLimitedBody(7, 30))).toBe(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"Rate limit exceeded; retry after 30 seconds","data":{"reason":"rate_limited","retryAfterSeconds":30}}}',
    );
    expect(JSON.stringify(rateLimitedBody(null, 1))).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Rate limit exceeded; retry after 1 seconds","data":{"reason":"rate_limited","retryAfterSeconds":1}}}',
    );
  });

  it('SEC-10 the 503 body is the JSON-RPC rate_limit_unavailable error with the request id', () => {
    expect(JSON.stringify(rateLimitUnavailableBody('a'))).toBe(
      '{"jsonrpc":"2.0","id":"a","error":{"code":-32000,"message":"Rate limit check unavailable; retry later","data":{"reason":"rate_limit_unavailable","retryAfterSeconds":5}}}',
    );
  });
});
