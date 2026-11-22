// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { oauth1Header, percentEncode, signatureBaseString } from './oauth1.js';

const OAUTH = {
  oauth_consumer_key: '9djdj82h48djs9d2',
  oauth_token: 'kkk9d7dh3k39sjv7',
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: '137131201',
  oauth_nonce: '7d8f3e4a',
};

describe('CONN-3 OAuth 1.0a', () => {
  it('CONN-3 percent encoding follows RFC 5849 section 3.6', () => {
    expect(percentEncode('AZaz09-._~')).toBe('AZaz09-._~');
    expect(percentEncode(" !'()*+,/:;=?@[]%")).toBe('%20%21%27%28%29%2A%2B%2C%2F%3A%3B%3D%3F%40%5B%5D%25');
    expect(percentEncode('ü')).toBe('%C3%BC');
  });

  it('CONN-3 the base string reproduces RFC 5849 section 3.4.1.1 for its query and oauth parameters', () => {
    // The RFC example also has a form body (`c2&a3=2+q`); this signer takes the query and the oauth
    // parameters only. The expected string is the RFC's own text with the body's two parameters
    // (`a3%3D2%2520q` and `c2%3D`) removed, which is what its normalization rules give for the
    // reduced set: a2, a3=a, b5, c@ and the five oauth parameters, sorted by encoded name.
    const url = new URL('http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b');
    const expected =
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D' +
      '%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1' +
      '%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7';
    expect(signatureBaseString('POST', url, OAUTH)).toBe(expected);
  });

  it('CONN-3 base string URI: lower-case scheme and host, default port dropped, other port kept, no query', () => {
    expect(signatureBaseString('get', new URL('HTTPS://Shop.Example.TEST:443/a/b?x=1'), {})).toMatch(/^GET&https%3A%2F%2Fshop\.example\.test%2Fa%2Fb&/);
    expect(signatureBaseString('GET', new URL('http://h.test:80/'), {})).toMatch(/^GET&http%3A%2F%2Fh\.test%2F&/);
    expect(signatureBaseString('GET', new URL('https://h.test:8443/p'), {})).toMatch(/^GET&https%3A%2F%2Fh\.test%3A8443%2Fp&/);
  });

  it('CONN-3 repeated names sort by value, brackets and spaces are encoded twice', () => {
    const url = new URL('https://shop.example.test/rest/V1/products?searchCriteria[filter_groups][0][filters][0][field]=name&a=2&a=1&q=x y');
    const base = signatureBaseString('GET', url, {});
    expect(base).toContain('a%3D1%26a%3D2');
    expect(base).toContain('q%3Dx%2520y');
    expect(base).toContain('searchCriteria%255Bfilter_groups%255D%255B0%255D%255Bfilters%255D%255B0%255D%255Bfield%255D%3Dname');
    expect(base.split('&')[1]).toBe('https%3A%2F%2Fshop.example.test%2Frest%2FV1%2Fproducts');
  });

  it('CONN-3 a plus in a query is a space and a stray percent is kept literally', () => {
    const base = signatureBaseString('GET', new URL('https://h.test/p?a=x+y&b=100%'), {});
    expect(base).toContain('a%3Dx%2520y');
    expect(base).toContain('b%3D100%2525');
  });

  const input = {
    method: 'GET',
    url: new URL('https://shop.example.test/rest/V1/products?q=a b'),
    consumerKey: 'ck',
    consumerSecret: 'cs&1',
    token: 'tk',
    tokenSecret: 'ts 2',
    nonce: 'fixednonce',
    timestamp: 1_700_000_000,
  };

  for (const [signatureMethod, algorithm] of [
    ['HMAC-SHA256', 'sha256'],
    ['HMAC-SHA1', 'sha1'],
  ] as const) {
    it(`CONN-3 ${signatureMethod} header carries the HMAC over the base string with key enc(consumer)&enc(token)`, () => {
      const header = oauth1Header({ ...input, signatureMethod });
      const params = {
        oauth_consumer_key: 'ck',
        oauth_nonce: 'fixednonce',
        oauth_signature_method: signatureMethod,
        oauth_timestamp: '1700000000',
        oauth_token: 'tk',
        oauth_version: '1.0',
      };
      const base = signatureBaseString('GET', input.url, params);
      const signature = createHmac(algorithm, 'cs%261&ts%202').update(base).digest('base64');
      expect(header).toBe(
        'OAuth oauth_consumer_key="ck", oauth_nonce="fixednonce", oauth_signature_method="' +
          `${signatureMethod}", oauth_timestamp="1700000000", oauth_token="tk", oauth_version="1.0", ` +
          `oauth_signature="${encodeURIComponent(signature)}"`,
      );
    });
  }

  it('CONN-3 SEC-3 the header never contains a secret', () => {
    const header = oauth1Header({ ...input, consumerSecret: 'sentinel-consumer-secret', tokenSecret: 'sentinel-token-secret', signatureMethod: 'HMAC-SHA256' });
    expect(header).not.toContain('sentinel');
  });
});
