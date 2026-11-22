// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { createScrubber } from './scrub.js';

describe('SEC-3 scrubbing', () => {
  const token = 's3cr3t-token';
  const b64 = Buffer.from(token).toString('base64');
  const enc = encodeURIComponent('s3cr3t token/+=');

  it('SEC-3 replaces raw, Base64 and URL-encoded forms in text', () => {
    const s = createScrubber([token, 's3cr3t token/+=']);
    expect(s.text(`a ${token} b ${b64} c ${enc}`)).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });

  it('SEC-3 scrubs nested objects, arrays and keys without mutating the input', () => {
    const s = createScrubber([token]);
    const input = { [token]: 1, list: [token, { deep: `x${b64}y` }], n: 5, ok: true, nil: null };
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    const out = s.deep(input);
    expect(out).toEqual({ '[REDACTED]': 1, list: ['[REDACTED]', { deep: 'x[REDACTED]y' }], n: 5, ok: true, nil: null });
    expect(input).toEqual(copy);
  });

  it('SEC-3 scrubs a Basic header value supplied as a combined secret', () => {
    const basic = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(basic).toBe('Basic dXNlcjpwYXNz');
    const s = createScrubber(['pass', basic]);
    expect(s.text(`sent ${basic}`)).toBe('sent [REDACTED]');
  });

  it('SEC-3 ignores empty secrets and replaces longest first', () => {
    const s = createScrubber(['', 'abc', 'abcdef']);
    expect(s.text('x abcdef y')).toBe('x [REDACTED] y');
    expect(createScrubber(['']).text('unchanged')).toBe('unchanged');
  });

  it('SEC-3 scrubs form-urlencoded and base64url forms', () => {
    const secret = 'a b>?c~';
    const s = createScrubber([secret]);
    const form = encodeURIComponent(secret).replace(/%20/g, '+');
    const b64url = Buffer.from(secret).toString('base64url');
    expect(form).toContain('+');
    expect(s.text(`${form} ${b64url}`)).toBe('[REDACTED] [REDACTED]');
  });

  it('SEC-3 keeps __proto__ as an own property and does not pollute', () => {
    const input = JSON.parse('{"__proto__": {"x": "s3cr3t-token"}}') as object;
    const out = createScrubber([token]).deep(input);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('SEC-3 caps recursion depth at 64', () => {
    let v: unknown = token;
    for (let i = 0; i < 100; i++) v = { n: v };
    let out = createScrubber([token]).deep(v) as Record<string, unknown>;
    let depth = 0;
    while (typeof out === 'object') {
      out = out.n as Record<string, unknown>;
      depth++;
    }
    expect(out).toBe('[depth limit]');
    expect(depth).toBeLessThanOrEqual(65);
  });
});
