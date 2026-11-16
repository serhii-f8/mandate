import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import type { ConnectionSettings } from '@aiops/connector-sdk';
import { allowedHostsOf, createGuardedLookup, EgressDeniedError, isBlockedAddress } from './egress.js';

const settings = (over: Partial<ConnectionSettings> = {}): ConnectionSettings => ({
  id: 'c1',
  baseUrl: 'https://Shop.Example.com:8443/rest',
  auth: { scheme: 'oauth_client_credentials', tokenUrl: 'https://auth.example.com/token', scopes: [] },
  timeoutMs: 1000,
  retry: { maxAttempts: 1, initialBackoffMs: 1 },
  maxConcurrency: 1,
  allowPrivateNetwork: false,
  extraHosts: ['Spec.Example.com.'],
  ...over,
});

interface Result {
  err: Error | null;
  address: string | LookupAddress[] | undefined;
  family: number | undefined;
}
const call = (
  lookup: ReturnType<typeof createGuardedLookup>,
  host: string,
  options: { all?: boolean; family?: number } = {},
): Promise<Result> =>
  new Promise((resolve) => {
    // The Node callback has two shapes (single address or array); capture both loosely.
    (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      host,
      options,
      (err: unknown, address: unknown, family: unknown) => { resolve({ err: err as Error | null, address: address as Result['address'], family: family as number | undefined }); },
    );
  });

describe('CONN-5 outbound restriction', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '224.0.0.1', '240.0.0.1', '::', '::1', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '2001:db8::1',
  ])('CONN-5 blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34', '::ffff:5db8:d822', '172.32.0.1', '64:ff9b::5db8:d822'])(
    'CONN-5 allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it('CONN-5 treats unparseable input as blocked', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('CONN-5 derives allowed hosts from baseUrl, tokenUrl and extraHosts', () => {
    expect([...allowedHostsOf(settings())].sort()).toEqual(['auth.example.com', 'shop.example.com', 'spec.example.com']);
  });

  it('CONN-5 refuses a host that is not declared, without resolving it', async () => {
    let resolved = false;
    const lookup = createGuardedLookup(settings(), () => {
      resolved = true;
      return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    });
    const { err } = await call(lookup, 'evil.example.org');
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).code).toBe('egress_denied');
    expect(err?.message).toContain('evil.example.org');
    expect(resolved).toBe(false);
  });

  it('CONN-5 refuses a declared host that resolves to a private address', async () => {
    const lookup = createGuardedLookup(settings(), () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]));
    const { err } = await call(lookup, 'shop.example.com');
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect(err?.message).not.toContain('10.0.0.5');
  });

  it('CONN-5 refuses when any resolved address is blocked', async () => {
    const lookup = createGuardedLookup(settings(), () => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:a00:1', family: 6 },
    ]));
    const { err } = await call(lookup, 'shop.example.com', { all: true });
    expect(err).toBeInstanceOf(EgressDeniedError);
  });

  it('CONN-5 accepts a private resolution when allowPrivateNetwork is set', async () => {
    const lookup = createGuardedLookup(settings({ allowPrivateNetwork: true }), () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]));
    const r = await call(lookup, 'SHOP.example.com.');
    expect(r.err).toBeNull();
    expect(r.address).toBe('10.0.0.5');
    expect(r.family).toBe(4);
  });

  it('CONN-5 returns an array when options.all is true', async () => {
    const lookup = createGuardedLookup(settings(), () => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]));
    const r = await call(lookup, 'shop.example.com', { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('CONN-5 checks IP-literal hosts without DNS', async () => {
    const resolver = (): Promise<{ address: string; family: number }[]> => Promise.reject(new Error('resolver must not be called'));
    const literal = settings({ baseUrl: 'http://127.0.0.1:4390', extraHosts: [] });
    const denied = await call(createGuardedLookup(literal, resolver), '127.0.0.1');
    expect(denied.err).toBeInstanceOf(EgressDeniedError);
    const ok = await call(createGuardedLookup({ ...literal, allowPrivateNetwork: true }, resolver), '127.0.0.1');
    expect(ok.err).toBeNull();
    expect(ok.address).toBe('127.0.0.1');
    expect(ok.family).toBe(4);
  });

  it('CONN-5 refuses an empty resolution', async () => {
    const lookup = createGuardedLookup(settings(), () => Promise.resolve([]));
    expect((await call(lookup, 'shop.example.com')).err).toBeInstanceOf(EgressDeniedError);
  });
});
