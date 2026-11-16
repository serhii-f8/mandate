export const REDACTED = '[REDACTED]';

export interface Scrubber {
  text(s: string): string;
  /** Returns a new structure with every string value and object key scrubbed; the input is not mutated. */
  deep<T>(v: T): T;
}

/** Replaces each secret, and its Base64 and URL-encoded forms, with `[REDACTED]` (SEC-3). Longest first. */
export function createScrubber(secrets: readonly string[]): Scrubber {
  const forms = new Set<string>();
  for (const s of secrets) {
    if (s === '') continue;
    forms.add(s);
    forms.add(Buffer.from(s).toString('base64'));
    forms.add(encodeURIComponent(s));
  }
  const ordered = [...forms].filter((f) => f !== '').sort((a, b) => b.length - a.length);
  const text = (s: string): string => {
    let out = s;
    for (const f of ordered) out = out.split(f).join(REDACTED);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[text(k)] = walk(val);
      return out;
    }
    return v;
  };
  return { text, deep: <T>(v: T): T => walk(v) as T };
}
