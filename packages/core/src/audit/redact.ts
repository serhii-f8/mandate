/** Replacement for a redacted key's value or a credential-shaped string (AUD-4). */
export const REDACTED = '[redacted]';

/** Keys whose value is never audited (SEC-3). Matches keys only, never values. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authori[sz]ation|api[-_]?key|credential|cookie/i;
const BEARER = /^Bearer\s/i;
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, sensitiveKeys: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return BEARER.test(value) || JWT.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((element: unknown) => redactValue(element, sensitiveKeys));
  if (isPlainObject(value)) return redactObject(value, sensitiveKeys);
  return value;
}

function redactObject(source: Readonly<Record<string, unknown>>, sensitiveKeys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = SENSITIVE_KEY.test(key) || sensitiveKeys.has(key) ? REDACTED : redactValue(value, sensitiveKeys);
  }
  return out;
}

/**
 * Backstop redaction of audit details before they are stored (AUD-4, SEC-3). A key matching the
 * credential pattern, or exactly one of `sensitiveKeys` (manifest `sensitive_fields`), has its
 * value replaced whole; a bearer or JWT-shaped string is replaced wherever it is. Arrays and plain
 * objects are walked; every other value is kept. Returns a new object; the input is not mutated.
 */
export function redactAuditDetails(
  details: Readonly<Record<string, unknown>>,
  sensitiveKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return redactObject(details, sensitiveKeys);
}
