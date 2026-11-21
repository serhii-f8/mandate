// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The vendored spec and the sandbox recordings of the Gitea preset (NFR-17). `pnpm record`
 * writes them from the sandbox; these tests pin their shape without a sandbox: every case of
 * test/cases.json and test/write-cases.json has a recording of the same requests, nothing
 * credential-like is stored, and the spec holds exactly the preset endpoints.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RecordedExchange } from '@aiops/testing';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (...parts: string[]): Promise<unknown> => JSON.parse(await readFile(join(root, ...parts), 'utf8')) as unknown;

interface ReadCase {
  readonly name: string;
  readonly exchanges: readonly RecordedExchange['request'][];
  readonly expect: { readonly numbers?: readonly number[]; readonly names?: readonly string[]; readonly labels?: Readonly<Record<string, readonly string[]>> };
}
interface WriteCase {
  readonly name: string;
  readonly steps: readonly RecordedExchange['request'][];
}
interface Recording {
  readonly exchanges: readonly RecordedExchange[];
}

const readCases = (await readJson('test', 'cases.json')) as ReadCase[];
const writeCases = (await readJson('test', 'write-cases.json')) as WriteCase[];
const recording = async (dir: 'recordings' | 'recordings/write', name: string): Promise<Recording> =>
  (await readJson('test', ...dir.split('/'), `${name}.json`)) as Recording;

/** Replaces `{ "$label": name }` in a write step with the id from the case's own labels listing. */
function resolveLabels(value: unknown, labels: readonly { id: number; name: string }[]): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveLabels(v, labels));
  if (typeof value === 'object' && value !== null) {
    const ref = (value as { $label?: unknown }).$label;
    if (typeof ref === 'string') return labels.find((l) => l.name === ref)?.id;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveLabels(v, labels)]));
  }
  return value;
}

const numbersOf = (ex: RecordedExchange): number[] =>
  (Array.isArray(ex.response.body) ? (ex.response.body as { number: number }[]) : [ex.response.body as { number: number }]).map((i) => i.number);

const HEX40 = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/;
const TOKEN_WORD = /token\s+[0-9a-f]{20,}/i;

/** Every string below `node` outside keys named like `sha`. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (!/sha/i.test(k)) strings(v, out);
    }
  }
  return out;
}

async function recordingFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of ['recordings', 'recordings/write']) {
    for (const f of await readdir(join(root, 'test', dir))) if (f.endsWith('.json')) files.push(join(root, 'test', dir, f));
  }
  return files;
}

describe('NFR-17 Gitea recordings', () => {
  it('NFR-17 every case has a recording whose requests equal the case requests', async () => {
    expect(readCases.length).toBeGreaterThan(0);
    expect(writeCases.length).toBeGreaterThan(0);
    for (const c of readCases) {
      const rec = await recording('recordings', c.name);
      expect(rec.exchanges.map((e) => e.request), c.name).toEqual(c.exchanges);
    }
    for (const c of writeCases) {
      const rec = await recording('recordings/write', c.name);
      let labels: { id: number; name: string }[] = [];
      const wanted: unknown[] = [];
      for (const [i, step] of c.steps.entries()) {
        wanted.push({ ...step, ...(step.body === undefined ? {} : { body: resolveLabels(step.body, labels) }) });
        const body = rec.exchanges[i]?.response.body;
        if (step.method === 'GET' && Array.isArray(body)) labels = body as { id: number; name: string }[];
      }
      expect(rec.exchanges.map((e) => e.request), c.name).toEqual(wanted);
    }
  });

  it('NFR-17 the read recordings hold what each case expects', async () => {
    for (const c of readCases) {
      const rec = await recording('recordings', c.name);
      const answered = rec.exchanges.filter((e) => e.response.status === 200);
      if (c.expect.numbers !== undefined) expect(answered.flatMap(numbersOf), c.name).toEqual(c.expect.numbers);
      if (c.expect.names !== undefined) expect((answered[0]?.response.body as { name: string }[]).map((l) => l.name), c.name).toEqual(c.expect.names);
      for (const [number, names] of Object.entries(c.expect.labels ?? {})) {
        const issue = answered.map((e) => e.response.body as { number: number; labels: { name: string }[] }).find((i) => String(i.number) === number);
        expect(issue?.labels.map((l) => l.name).sort(), `${c.name} #${number}`).toEqual([...names].sort());
      }
    }
    const missing = (await recording('recordings', 'get-many-website')).exchanges.at(-1);
    expect(missing?.response.status).toBe(404);
  });

  it('NFR-17 no recording or the spec contains a token-like value', async () => {
    const spec = JSON.stringify(await readJson('spec', 'gitea.swagger.json'));
    expect(spec).not.toMatch(HEX40);
    expect(spec).not.toMatch(TOKEN_WORD);
    for (const file of await recordingFiles()) {
      const text = await readFile(file, 'utf8');
      expect(text.toLowerCase(), file).not.toContain('authorization');
      expect(text, file).not.toMatch(TOKEN_WORD);
      for (const s of strings(JSON.parse(text))) expect(s, file).not.toMatch(HEX40);
    }
  });

  it('NFR-17 the vendored spec holds exactly the preset endpoints', async () => {
    const spec = (await readJson('spec', 'gitea.swagger.json')) as {
      swagger: string;
      basePath: string;
      securityDefinitions: Record<string, unknown>;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.swagger).toBe('2.0');
    expect(spec.basePath).toBe('/api/v1');
    expect(spec.securityDefinitions).toHaveProperty('AuthorizationHeaderToken');
    const methods = Object.fromEntries(
      Object.entries(spec.paths).map(([p, item]) => [p, Object.keys(item).filter((k) => k !== 'parameters').sort()]),
    );
    expect(methods).toEqual({
      '/repos/{owner}/{repo}/issues': ['get'],
      '/repos/{owner}/{repo}/issues/{index}': ['get', 'patch'],
      '/repos/{owner}/{repo}/issues/{index}/comments': ['post'],
      '/repos/{owner}/{repo}/issues/{index}/labels': ['put'],
      '/repos/{owner}/{repo}/labels': ['get'],
    });
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === 'object' && node !== null) {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const m = /^#\/(definitions|parameters|responses)\/(.+)$/.exec(ref);
      expect(m, ref).not.toBeNull();
      const section = (spec as unknown as Record<string, Record<string, unknown> | undefined>)[m?.[1] ?? ''];
      expect(section?.[m?.[2] ?? ''], ref).toBeDefined();
    }
  });

  it('NFR-17 put-names-drops-unknown shows Gitea dropping an unknown name with 200', async () => {
    const rec = await recording('recordings/write', 'put-names-drops-unknown');
    const [ex] = rec.exchanges;
    expect(rec.exchanges).toHaveLength(1);
    expect(ex?.request.body).toEqual({ labels: ['feature', 'no-such-label'] });
    expect(ex?.response.status).toBe(200);
    expect((ex?.response.body as { name: string }[]).map((l) => l.name)).toEqual(['feature']);
  });
});
