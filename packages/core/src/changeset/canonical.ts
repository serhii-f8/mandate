/** Deterministic JSON: sorted keys (UTF-16 code unit order), no whitespace. Used for hashing (CS-4). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

/** Orders strings by Unicode code point (equals PostgreSQL COLLATE "C" on UTF-8). */
export function compareTargetIds(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true) return rb.done === true ? 0 : -1;
    if (rb.done === true) return 1;
    // Iterating a string yields whole code points, so codePointAt(0) is never undefined.
    const ca = ra.value.codePointAt(0) ?? 0;
    const cb = rb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

/** Copy of args whose id array argument is strings, de-duplicated and sorted (CS-4). */
export function normalizeArgs(
  args: Readonly<Record<string, unknown>>,
  idsArg: string | undefined,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...args };
  if (idsArg === undefined) return copy;
  const ids = copy[idsArg];
  if (Array.isArray(ids)) {
    copy[idsArg] = [...new Set(ids.map((v) => String(v)))].sort(compareTargetIds);
  }
  return copy;
}
