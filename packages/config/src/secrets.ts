/**
 * CFG-5: secrets never appear in configuration files. Strict schemas reject
 * unknown keys almost everywhere; this scan also covers the open objects
 * and names the rule. `input_schema` is skipped and the argument names of a
 * connection test's `args` are not checked: argument names such as `page_token`
 * are legitimate there (ADR 0015).
 */
const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|bearer|credential/i;
/** Keys that name a reference or an endpoint, never secret material. */
const ALLOWED_KEY = /(^|_)credential_ref$|^manage_credentials$|^token_url$/;
const SKIPPED_SUBTREES = new Set(['input_schema']);

export const SECRET_MESSAGE = 'secrets never appear in configuration; reference a credential by name';

export function findSecretKeys(value: unknown, path: readonly PropertyKey[] = []): (readonly PropertyKey[])[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown, index) => findSecretKeys(item, [...path, index]));
  if (typeof value !== 'object' || value === null) return [];
  // Connection test `args` are keyed by argument names (`page_token` is legitimate there);
  // only the values below them are scanned.
  const argumentNames = path.length >= 2 && path[path.length - 1] === 'args' && path[path.length - 2] === 'test';
  const found: (readonly PropertyKey[])[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SKIPPED_SUBTREES.has(key)) continue;
    const childPath = [...path, key];
    if (!argumentNames && SECRET_KEY.test(key) && !ALLOWED_KEY.test(key)) found.push(childPath);
    found.push(...findSecretKeys(child, childPath));
  }
  return found;
}
