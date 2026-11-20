/**
 * Client address keys for the unauthenticated rate limit (SEC-10). An IPv4 address (also when
 * IPv4-mapped in dotted form) is its own key; an IPv6 address is keyed by its /64, the smallest
 * block a single subscriber usually holds, so rotating through one prefix gains nothing. Anything
 * that is not an IP address becomes `unknown`, which shares one budget (fails safe).
 */
import { isIP } from 'node:net';

const UNKNOWN = 'unknown';
const MAPPED_PREFIX = '::ffff:';

/** The first four 16-bit groups of a valid IPv6 address (zone already removed), without leading zeros. */
function prefix64(address: string): string {
  const [head = '', tail] = address.split('::', 2);
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const headGroups = groupsOf(head);
  // A trailing dotted IPv4 part stands for two groups; it never reaches the first four.
  const tailWidth = tail === undefined ? 0 : groupsOf(tail).reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const zeros = tail === undefined ? [] : Array.from({ length: 8 - headGroups.length - tailWidth }, () => '0');
  const expanded = [...headGroups, ...zeros, ...(tail === undefined ? [] : groupsOf(tail))];
  return `${expanded
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

export function normalizeAddress(ip: string | undefined): string {
  if (ip === undefined) return UNKNOWN;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return UNKNOWN;
  const address = ip.toLowerCase().split('%', 1)[0] ?? '';
  if (address.startsWith(MAPPED_PREFIX)) {
    const v4 = address.slice(MAPPED_PREFIX.length);
    if (isIP(v4) === 4) return v4;
  }
  return prefix64(address);
}

/** The rate-limit key part of a request's client address (`req.ip`, which honours `trust proxy`). */
export function clientAddress(req: { ip?: string | undefined }): string {
  return normalizeAddress(req.ip);
}
