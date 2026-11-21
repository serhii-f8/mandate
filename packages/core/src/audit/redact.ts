// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** Replacement for a redacted key's value or a credential-shaped string (AUD-4). */
export const REDACTED = '[redacted]';

/** Keys whose value is never audited (SEC-3). Matches keys only, never values. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authori[sz]ation|api[-_]?key|credential|cookie/i;
const BEARER = /^Bearer\s/i;
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Details that cannot be redacted: a value refers back to itself on the walked path. */
export class AuditRedactionError extends Error {
  override readonly name = 'AuditRedactionError';
  constructor(readonly reason: 'cycle') {
    super(`audit details cannot be redacted (${reason})`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, sensitiveKeys: ReadonlySet<string>, path: WeakSet<object>): unknown {
  if (typeof value === 'string') return BEARER.test(value) || JWT.test(value) ? REDACTED : value;
  if (Array.isArray(value)) {
    return walk(value, path, () => value.map((element: unknown) => redactValue(element, sensitiveKeys, path)));
  }
  if (isPlainObject(value)) return redactObject(value, sensitiveKeys, path);
  return value;
}

/** Runs `step` with `node` on the current path; a node already on the path is a cycle. */
function walk<T>(node: object, path: WeakSet<object>, step: () => T): T {
  if (path.has(node)) throw new AuditRedactionError('cycle');
  path.add(node);
  try {
    return step();
  } finally {
    path.delete(node);
  }
}

function redactObject(
  source: Readonly<Record<string, unknown>>,
  sensitiveKeys: ReadonlySet<string>,
  path: WeakSet<object>,
): Record<string, unknown> {
  return walk(source, path, () => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      const redacted = SENSITIVE_KEY.test(key) || sensitiveKeys.has(key) ? REDACTED : redactValue(value, sensitiveKeys, path);
      // An own-property definition, not assignment: a `__proto__` key stays a key instead of setting the prototype.
      Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return out;
  });
}

/**
 * Backstop redaction of audit details before they are stored (AUD-4, SEC-3). A key matching the
 * credential pattern, or exactly one of `sensitiveKeys` (manifest `sensitive_fields`), has its
 * value replaced whole; a bearer or JWT-shaped string is replaced wherever it is. Arrays and plain
 * objects are walked; every other value is kept. Returns a new object; the input is not mutated.
 * Throws `AuditRedactionError` when a value refers back to itself.
 */
export function redactAuditDetails(
  details: Readonly<Record<string, unknown>>,
  sensitiveKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return redactObject(details, sensitiveKeys, new WeakSet());
}
