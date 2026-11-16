import { randomUUID } from 'node:crypto';

const HEADER = 'x-correlation-id';

interface HeaderTarget {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * One correlation ID per page request, returned as `x-correlation-id` (design §7).
 * Idempotent per response, so the guard and the handler share one ID.
 */
export function pageCorrelation(_req: unknown, res: HeaderTarget): string {
  const existing = res.getHeader(HEADER);
  if (typeof existing === 'string' && existing !== '') return existing;
  const id = randomUUID();
  res.setHeader(HEADER, id);
  return id;
}
