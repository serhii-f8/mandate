import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { ConnectionSettings } from '@aiops/connector-sdk';

/** Outbound connection refused by the egress guard (CONN-5). The message names the host only. */
export class EgressDeniedError extends Error {
  readonly code = 'egress_denied';
  constructor(host: string) {
    super(`egress denied for host ${host}`);
    this.name = 'EgressDeniedError';
  }
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true });

function parseIpv4(s: string): number | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** [base, prefix length] */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Blocked(n: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const b = parseIpv4(base) ?? 0;
    const size = 2 ** (32 - bits);
    return Math.floor(n / size) === Math.floor(b / size);
  });
}

/** Parse an IPv6 literal into eight 16-bit groups, or undefined when malformed. */
function parseIpv6(input: string): number[] | undefined {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const toGroups = (h: string): number[] | undefined => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  if (!head) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const rest = toGroups(halves[1] ?? '');
    if (!rest || head.length + rest.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  if (tail.length === 2) groups = [...groups.slice(0, 6), ...tail];
  return groups;
}

/** True when the address is in a range the egress guard refuses (spec §4.5). Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = parseIpv4(ip);
    return n === undefined || v4Blocked(n);
  }
  if (family !== 6) return true;
  const g = parseIpv6(ip);
  if (!g) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, h = 0] = g;
  const embedded = g6 * 65536 + h;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96 incl. ::, ::1, IPv4-compatible
  // IPv4-mapped ::ffff:0:0/96
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return v4Blocked(embedded);
  // NAT64 64:ff9b::/96
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return v4Blocked(embedded);
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local, deprecated)
  if (a === 0x2002) return v4Blocked(b * 65536 + c); // 6to4 2002::/16 with embedded IPv4
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8
  if (a === 0x2001 && b === 0x0db8) return true; // documentation 2001:db8::/32
  return false;
}

function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function hostOfUrl(url: string): string | undefined {
  try {
    return normaliseHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** Hosts this connection may reach: base URL, OAuth token URL and extra hosts. Lower-case, no port. */
export function allowedHostsOf(settings: ConnectionSettings): Set<string> {
  const hosts = new Set<string>();
  const base = hostOfUrl(settings.baseUrl);
  if (base) hosts.add(base);
  if (settings.auth?.scheme === 'oauth_client_credentials') {
    const t = hostOfUrl(settings.auth.tokenUrl);
    if (t) hosts.add(t);
  }
  for (const h of settings.extraHosts) {
    let n: string | undefined;
    try {
      n = normaliseHost(new URL(`http://${h.trim()}`).hostname);
    } catch {
      n = undefined; // an unparseable entry allows nothing
    }
    if (n) hosts.add(n);
  }
  return hosts;
}

function checkHost(settings: ConnectionSettings, allowed: Set<string>, hostname: string): string {
  const host = normaliseHost(hostname);
  if (!allowed.has(host)) throw new EgressDeniedError(host);
  if (isIP(host) && !settings.allowPrivateNetwork && isBlockedAddress(host)) throw new EgressDeniedError(host);
  return host;
}

/**
 * Synchronous pre-connect check (CONN-5). Node's `net` never calls the `lookup` option for IP-literal
 * hosts, so the HTTP layer MUST call this before every request (and every redirect target, token
 * fetch and spec fetch). Names are checked against the allow list only; their addresses are checked
 * by `createGuardedLookup`. Throws `EgressDeniedError`.
 */
export function assertEgressAllowed(settings: ConnectionSettings, hostname: string): void {
  checkHost(settings, allowedHostsOf(settings), hostname);
}

/**
 * A `net.LookupFunction` for the HTTP agent: refuses undeclared hosts and blocked addresses, and
 * hands the checked address to the socket so there is no second resolution (CONN-5).
 */
export function createGuardedLookup(settings: ConnectionSettings, resolver: Resolver = defaultResolver): LookupFunction {
  const allowed = allowedHostsOf(settings);
  const resolve = async (hostname: string): Promise<LookupAddress[]> => {
    const host = checkHost(settings, allowed, hostname);
    const literal = isIP(host);
    const addrs: { address: string; family: number }[] = literal ? [{ address: host, family: literal }] : await resolver(host);
    if (addrs.length === 0) throw new EgressDeniedError(host);
    if (!settings.allowPrivateNetwork && addrs.some((a) => isBlockedAddress(a.address))) throw new EgressDeniedError(host);
    return addrs.map((a) => ({ address: a.address, family: a.family }));
  };
  const fn = (hostname: string, options: { all?: boolean; family?: number | string }, callback: (...args: never[]) => void): void => {
    resolve(hostname).then(
      (addrs) => {
        const want = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
        const usable = want ? addrs.filter((a) => a.family === want) : addrs;
        const cb = callback as unknown as (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
        const first = usable[0];
        if (!first) {
          const host = normaliseHost(hostname);
          cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }));
        } else if (options.all) {
          cb(null, usable);
        } else {
          cb(null, first.address, first.family);
        }
      },
      (err: unknown) => {
        (callback as unknown as (e: Error) => void)(err instanceof Error ? err : new EgressDeniedError(normaliseHost(hostname)));
      },
    );
  };
  // Node's LookupFunction overloads are satisfied by this runtime-checked implementation.
  return fn as unknown as LookupFunction;
}
