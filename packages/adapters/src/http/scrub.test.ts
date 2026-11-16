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
});
