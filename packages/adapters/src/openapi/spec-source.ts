// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Spec loading (CONN-2, design §4.2): a file (JSON or YAML, up to 5 MB) or a URL fetched through
 * the connection client (egress guard, timeouts, retries). Messages are fixed strings: they never
 * quote file contents, upstream bodies or parser output (SEC-3).
 */
import { open } from 'node:fs/promises';
import type { SpecIssue } from '@aiops/connector-sdk';
import { parse as parseYaml } from 'yaml';
import type { ConnectionClient } from '../http/client.js';

/** Spec size limit (design §4.2). */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;

const SPEC_PATH = ['openapi', 'spec'] as const;

export type SpecLoadResult = { ok: true; doc: unknown } | { ok: false; issues: SpecIssue[] };

const fail = (message: string): SpecLoadResult => ({ ok: false, issues: [{ path: [...SPEC_PATH], message }] });

/** Parses spec text as JSON, or as YAML when it is not JSON. */
export function parseSpecText(text: string): SpecLoadResult {
  try {
    return { ok: true, doc: JSON.parse(text) as unknown };
  } catch {
    // not JSON: try YAML below
  }
  try {
    // yaml 2 uses the core schema by default (no timestamps, no custom tags) and limits aliases.
    return { ok: true, doc: parseYaml(text) as unknown };
  } catch {
    return fail('the spec is not valid JSON or YAML');
  }
}

/** Reads a spec file. The path is used as given; the configuration loader resolves relative paths. */
export async function loadSpecFile(path: string): Promise<SpecLoadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch {
    return fail('the spec file could not be read');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return fail('the spec file could not be read');
    if (stat.size > MAX_SPEC_BYTES) return fail('the spec exceeds 5 MB');
    // Read at most one byte past the limit, so a file that grows after stat is still caught.
    const buf = Buffer.alloc(MAX_SPEC_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, size, buf.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_SPEC_BYTES) return fail('the spec exceeds 5 MB');
    }
    return parseSpecText(buf.subarray(0, size).toString('utf8'));
  } catch {
    return fail('the spec file could not be read');
  } finally {
    await handle.close();
  }
}

/**
 * Fetches a spec URL through the connection client. The client enforces the egress guard, JSON-only
 * responses and the 5 MB body limit. No credential is sent (Phase 3 has no `authenticated` specs).
 */
export async function fetchSpecUrl(client: ConnectionClient, rawUrl: string): Promise<SpecLoadResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail('the spec URL is not a valid URL');
  }
  const r = await client.send({ method: 'GET', url, headers: { accept: 'application/json' } }, { retryable: true });
  if (!r.ok) return fail(`the spec URL could not be fetched (${r.code}${r.status === undefined ? '' : ` ${r.status}`})`);
  return { ok: true, doc: r.json };
}
