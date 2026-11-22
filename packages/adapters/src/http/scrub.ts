// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
export const REDACTED = '[REDACTED]';
const DEPTH_LIMIT = '[depth limit]';
const MAX_DEPTH = 64;

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
    const uri = encodeURIComponent(s);
    forms.add(uri);
    forms.add(uri.replace(/%20/g, '+')); // application/x-www-form-urlencoded
    forms.add(Buffer.from(s).toString('base64url'));
  }
  const ordered = [...forms].filter((f) => f !== '').sort((a, b) => b.length - a.length);
  const text = (s: string): string => {
    let out = s;
    for (const f of ordered) out = out.split(f).join(REDACTED);
    return out;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return DEPTH_LIMIT;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // defineProperty keeps a "__proto__" key an own property instead of invoking the setter.
      Object.defineProperty(out, text(k), { value: walk(val, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return { text, deep: <T>(v: T): T => walk(v, 0) as T };
}
