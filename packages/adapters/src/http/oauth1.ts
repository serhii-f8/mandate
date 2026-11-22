// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHmac } from 'node:crypto';

/**
 * OAuth 1.0a request signing (CONN-3, ADR 0065), after RFC 5849 sections 3.4.1 (signature base
 * string), 3.4.2 (HMAC key), 3.5.1 (Authorization header) and 3.6 (percent encoding). HMAC-SHA256
 * is the same construction with SHA-256 and `oauth_signature_method=HMAC-SHA256`.
 *
 * The signed parameters are the query of the request URL and the oauth parameters. A request body
 * is never part of the signature: it is signed only when it is not form-encoded, which the callers
 * of this module (JSON bodies) satisfy.
 */

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** RFC 5849 section 3.6: UTF-8, everything but ALPHA, DIGIT and `-._~` as upper-case `%XX`. */
export function percentEncode(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Form decoding of a query component: `+` is a space, a `%XX` is a byte, a stray `%` stays. */
function formDecode(raw: string): string {
  const bytes: number[] = [];
  const text = Buffer.from(raw, 'utf8');
  for (let i = 0; i < text.length; i += 1) {
    const b = text[i] ?? 0;
    if (b === 0x2b) bytes.push(0x20);
    else if (b === 0x25 && /^[0-9A-Fa-f]{2}$/.test(text.subarray(i + 1, i + 3).toString('latin1'))) {
      bytes.push(Number.parseInt(text.subarray(i + 1, i + 3).toString('latin1'), 16));
      i += 2;
    } else bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

function queryPairs(url: URL): [string, string][] {
  const pairs: [string, string][] = [];
  for (const part of url.search.slice(1).split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    pairs.push(eq < 0 ? [formDecode(part), ''] : [formDecode(part.slice(0, eq)), formDecode(part.slice(eq + 1))]);
  }
  return pairs;
}

/** Section 3.4.1.2: lower-case scheme and host, the port only when it is not the default, no query. */
function baseStringUri(url: URL): string {
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname === '' ? '/' : url.pathname}`;
}

/** Section 3.4.1: METHOD & encoded base URI & encoded normalized parameters (query plus `oauthParams`). */
export function signatureBaseString(method: string, url: URL, oauthParams: Readonly<Record<string, string>>): string {
  const all: [string, string][] = [...queryPairs(url), ...Object.entries(oauthParams).filter(([name]) => name !== 'oauth_signature')];
  const encoded = all.map(([name, value]) => [percentEncode(name), percentEncode(value)] as const);
  // Byte order of the encoded names, then of the encoded values (3.4.1.3.2); both are ASCII.
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const normalized = encoded.map(([name, value]) => `${name}=${value}`).join('&');
  return `${percentEncode(method.toUpperCase())}&${percentEncode(baseStringUri(url))}&${percentEncode(normalized)}`;
}

export interface OAuth1Input {
  method: string;
  url: URL;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  signatureMethod: 'HMAC-SHA256' | 'HMAC-SHA1';
  nonce: string;
  /** Seconds since the epoch. */
  timestamp: number;
}

/** Section 3.4.2: the encoded consumer secret, `&`, the encoded token secret. */
export function oauth1SigningKey(consumerSecret: string, tokenSecret: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

/** The value of the `Authorization` header (section 3.5.1) for one request. */
export function oauth1Header(input: OAuth1Input): string {
  const params: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: input.signatureMethod,
    oauth_timestamp: String(Math.floor(input.timestamp)),
    oauth_token: input.token,
    oauth_version: '1.0',
  };
  const base = signatureBaseString(input.method, input.url, params);
  const algorithm = input.signatureMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1';
  const signature = createHmac(algorithm, oauth1SigningKey(input.consumerSecret, input.tokenSecret)).update(base).digest('base64');
  const fields = Object.entries({ ...params, oauth_signature: signature }).map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`);
  return `OAuth ${fields.join(', ')}`;
}
