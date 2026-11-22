// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The SEC-4 walk over a workflow history in its proto JSON form (base64 strings): every payload's
 * encoding, apart from SDK payloads that never pass the codec and are accepted only in their
 * exact, data-free shape.
 */

/** A key-and-value check: true when `value` under `key` is an accepted plaintext SDK payload. */
export type PayloadExemption = (key: string, value: unknown) => boolean;

/**
 * SDK-internal payloads that never pass the codec and carry only a patch id: the `core_patch`
 * marker's `patch-data` (`{ id, deprecated }`) and the `TemporalChangeVersion` search attribute
 * (`[id]`). The SEC-4 walk accepts them only when the decoded content has exactly that shape; any
 * other content under these keys is walked and reported like every other payload.
 */
const PATCH_ID = /^[a-z0-9-]+-\d{8}$/;

function isPatchData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value).sort();
  const v = value as { id?: unknown; deprecated?: unknown };
  return keys.join() === 'deprecated,id' && typeof v.id === 'string' && PATCH_ID.test(v.id) && typeof v.deprecated === 'boolean';
}

function isPatchIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && PATCH_ID.test(id));
}

/** The decoded data of a json/plain payload `{ metadata, data }` (proto JSON, base64), or `undefined`. */
function plainPayloadData(payload: unknown): { readonly value: unknown } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { metadata, data } = payload as { metadata?: { encoding?: unknown }; data?: unknown };
  if (typeof metadata?.encoding !== 'string' || Buffer.from(metadata.encoding, 'base64').toString('utf8') !== 'json/plain') return undefined;
  if (typeof data !== 'string') return undefined;
  try {
    return { value: JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as unknown };
  } catch {
    return undefined;
  }
}

/** A json/plain payload whose decoded data passes `check`. */
function isPlainPayload(payload: unknown, check: (decoded: unknown) => boolean): boolean {
  const decoded = plainPayloadData(payload);
  return decoded !== undefined && check(decoded.value);
}

/** True when `value` under `key` is a genuine SDK patch payload. */
export const isPatchMetadata: PayloadExemption = (key, value) => {
  if (key === 'TemporalChangeVersion') return isPlainPayload(value, isPatchIdList);
  if (key !== 'patch-data' || typeof value !== 'object' || value === null) return false;
  const payloads = (value as { payloads?: unknown }).payloads;
  return Array.isArray(payloads) && payloads.length === 1 && isPlainPayload(payloads[0], isPatchData);
};

/** The header the Temporal OpenTelemetry interceptors write (`TRACE_HEADER` of the package). */
export const TRACE_HEADER = '_tracer-data';

/** W3C `traceparent`, version 00: trace ID, parent span ID, flags (ADR 0047). */
export const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;

/** W3C trace context carried by a trace header: only `traceparent` and `tracestate`. */
export interface TraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

function isTraceContext(value: unknown): value is TraceContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value) as [string, unknown][];
  const has = (key: string): boolean => entries.some(([k]) => k === key);
  if (!entries.every(([k, v]) => (k === 'traceparent' || k === 'tracestate') && typeof v === 'string')) return false;
  const { traceparent } = value as TraceContext;
  // An empty carrier (no active span) is `{}`; a `tracestate` never travels without a `traceparent`.
  if (traceparent === undefined) return !has('tracestate');
  return TRACEPARENT.test(traceparent);
}

/** The W3C context of a `_tracer-data` payload, or `undefined` when it is anything else. */
export function traceContextOf(payload: unknown): TraceContext | undefined {
  const decoded = plainPayloadData(payload);
  return decoded !== undefined && isTraceContext(decoded.value) ? decoded.value : undefined;
}

/** The trace ID in a `traceparent`, or `undefined`. */
export function traceIdOf(context: TraceContext | undefined): string | undefined {
  return context?.traceparent === undefined ? undefined : TRACEPARENT.exec(context.traceparent)?.[1];
}

/** True when `value` under `key` is a trace header carrying only W3C trace context (ADR 0047). */
export const isTraceHeader: PayloadExemption = (key, value) => key === TRACE_HEADER && traceContextOf(value) !== undefined;

/** The patch payloads and the trace header: what a traced history may carry outside the codec. */
export const isSdkPlaintext: PayloadExemption = (key, value) => isPatchMetadata(key, value) || isTraceHeader(key, value);

/** Every payload's `metadata.encoding` in a history JSON (base64 in the proto JSON form), decoded. */
export function payloadEncodings(node: unknown, exempt: PayloadExemption = isPatchMetadata): string[] {
  if (Array.isArray(node)) return node.flatMap((n) => payloadEncodings(n, exempt));
  if (node === null || typeof node !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (exempt(key, value)) continue;
    if (key === 'metadata' && value !== null && typeof value === 'object') {
      const encoding: unknown = (value as { encoding?: unknown }).encoding;
      if (typeof encoding === 'string') found.push(Buffer.from(encoding, 'base64').toString('utf8'));
    }
    found.push(...payloadEncodings(value, exempt));
  }
  return found;
}

/** A json/plain payload in the proto JSON form, for the exemption tests. */
export const plain = (data: string): { metadata: { encoding: string }; data: string } => ({
  metadata: { encoding: Buffer.from('json/plain').toString('base64') },
  data: Buffer.from(data).toString('base64'),
});
