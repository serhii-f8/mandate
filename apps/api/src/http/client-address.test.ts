import { describe, expect, it } from 'vitest';
import { clientAddress, normalizeAddress } from './client-address.js';

describe('SEC-10 normalizes client addresses', () => {
  it('SEC-10 normalizes client addresses', () => {
    expect(normalizeAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeAddress('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(normalizeAddress('2001:DB8:AA:BB::9')).toBe('2001:db8:aa:bb::/64');
    expect(normalizeAddress('2001:db8:aa:bb::1')).toBe(normalizeAddress('2001:db8:aa:bb:ffff::2'));
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(normalizeAddress('::1')).toBe('0:0:0:0::/64');
    expect(normalizeAddress(undefined)).toBe('unknown');
    expect(normalizeAddress('not-an-ip')).toBe('unknown');
  });

  it('SEC-10 keeps leading zeros out of IPv6 groups and expands :: in any position', () => {
    expect(normalizeAddress('2001:0db8:00aa:000b::')).toBe('2001:db8:aa:b::/64');
    expect(normalizeAddress('::')).toBe('0:0:0:0::/64');
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('SEC-10 a hex-form mapped address falls into the ::/64 bucket (fails safe)', () => {
    expect(normalizeAddress('::ffff:7f00:1')).toBe('0:0:0:0::/64');
  });

  it('SEC-10 refuses empty, padded and oversized values', () => {
    expect(normalizeAddress('')).toBe('unknown');
    expect(normalizeAddress(' 203.0.113.7')).toBe('unknown');
    expect(normalizeAddress(`${'1:'.repeat(200)}1`)).toBe('unknown');
  });

  it('SEC-10 clientAddress normalizes req.ip', () => {
    expect(clientAddress({ ip: '::ffff:198.51.100.1' })).toBe('198.51.100.1');
    expect(clientAddress({})).toBe('unknown');
    expect(clientAddress({ ip: undefined })).toBe('unknown');
  });
});
