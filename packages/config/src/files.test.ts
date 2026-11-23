// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FILE_SETTINGS } from '@mandate/core';
import { loadConfigurationSources, type LoadedConfiguration, type LoadResult } from './load.js';
import { loadCodeFixture, presetWithoutUpdate, FIXTURE_PRESET_FILE } from '../test/code-fixture.js';

const CONNECTIONS = `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/rest }
  - { id: tools, adapter: mcp, mcp_url: http://tools.example.test/mcp }
`;
const PIN = `sha256:${'ab'.repeat(32)}`;

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties, required });
/** `/entry/content/data` with every parent an object that requires the next name. */
const NESTED = obj({ entry: obj({ content: obj({ data: { type: 'string', format: 'uuid' } }, ['data']) }, ['content']) }, ['entry']);
const FILE = { at: '/entry/content/data', send: 'base64', media_types: ['image/png'] };

function operation(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'media.upload',
    connection: 'shop',
    risk: 'write_opaque',
    description: 'Upload.',
    upstream: { method: 'POST', path: '/V1/media' },
    input_schema: NESTED,
    files: [FILE],
    ...extra,
  };
}

const doc = (body: Record<string, unknown>): string => JSON.stringify({ version: 1, ...body });

function load(files: Record<string, string>): Promise<LoadResult> {
  return loadConfigurationSources(Object.entries({ 'connections.yaml': CONNECTIONS, ...files }).map(([file, text]) => ({ file, text })));
}
const loadOp = (op: Record<string, unknown>, more: Record<string, string> = {}): Promise<LoadResult> => load({ 'ops.yaml': doc({ operations: [op] }), ...more });

function ok(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.configuration;
}
function found(result: LoadResult): { file: string; path: string; message: string }[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues.map(({ file, path, message }) => ({ file, path, message }));
}

async function refused(op: Record<string, unknown>, path: string, message: string, more: Record<string, string> = {}): Promise<void> {
  expect(found(await loadOp(op, more))).toEqual([{ file: 'ops.yaml', path, message }]);
}

describe('OPS-8 file arguments in configuration', () => {
  it('OPS-8 an opaque HTTP operation loads with its file arguments and the default settings', async () => {
    const config = ok(await loadOp(operation()));
    const definition = config.policy.operations.find((o) => o.id === 'media.upload');
    expect(definition?.files).toEqual([
      { pointer: '/entry/content/data', path: ['entry', 'content', 'data'], send: 'base64', mediaTypes: ['image/png'], maxBytes: 10_485_760 },
    ]);
    expect(config.files).toEqual(DEFAULT_FILE_SETTINGS);
  });

  it('OPS-8 a destructive operation without a manifest and a per-entry max_bytes load', async () => {
    const config = ok(await loadOp(operation({ risk: 'destructive', files: [{ ...FILE, max_bytes: 1000 }] }), { 'g.yaml': doc({ files: { max_bytes: 2000, keep_days: 0 } }) }));
    expect(config.policy.operations.find((o) => o.id === 'media.upload')?.files?.[0]?.maxBytes).toBe(1000);
    expect(config.files).toEqual({ ...DEFAULT_FILE_SETTINGS, maxBytes: 2000, keepDays: 0 });
  });

  it('OPS-8 an entry without max_bytes takes the global files.max_bytes', async () => {
    const config = ok(await loadOp(operation(), { 'g.yaml': doc({ files: { max_bytes: 2000 } }) }));
    expect(config.policy.operations.find((o) => o.id === 'media.upload')?.files?.[0]?.maxBytes).toBe(2000);
  });

  describe('where files are allowed', () => {
    const NOT_ALLOWED = 'is allowed only on an opaque operation with an HTTP binding';
    it('OPS-8 refuses files on a read operation', async () => {
      await refused(operation({ risk: 'read', upstream: { method: 'GET', path: '/V1/media' } }), 'operations[0].files', NOT_ALLOWED);
    });

    it('OPS-8 refuses files on a write operation with a manifest', async () => {
      const result = await loadOp(
        operation({
          risk: 'write',
          manifest: { id_field: 'sku', ids_arg: 'skus', values_arg: 'changes', fields: ['name'], scope_args: {}, read_before: { operation: 'media.read', ids_arg: 'skus' }, rollback: { strategy: 'replay_previous_state' } },
        }),
      );
      expect(found(result)).toContainEqual({ file: 'ops.yaml', path: 'operations[0].files', message: NOT_ALLOWED });
    });

    it('OPS-8 refuses files on an MCP-backed operation', async () => {
      await refused(operation({ connection: 'tools', upstream: { tool: 'send', pin: PIN } }), 'operations[0].files', NOT_ALLOWED);
    });

    describe('code operations', () => {
      const dirs: string[] = [];
      afterEach(async () => {
        await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
      });
      it('OPS-8 refuses files on a code operation', async () => {
        const preset = (await presetWithoutUpdate()).replace('    upstream: { code: ping }\n', `    upstream: { code: ping }\n    files:\n      - { at: /message, send: base64, media_types: [image/png] }\n`);
        const result = await loadCodeFixture(dirs, { preset });
        if (result.ok) throw new Error('expected issues');
        expect(result.issues).toContainEqual(expect.objectContaining({ file: FIXTURE_PRESET_FILE, message: NOT_ALLOWED }));
      });
    });
  });

  describe('the input schema', () => {
    it('OPS-8 needs an explicit input_schema', async () => {
      const without = operation();
      delete without.input_schema;
      const result = found(await loadOp(without));
      expect(result).toContainEqual({ file: 'ops.yaml', path: 'operations[0].input_schema', message: 'is required for an operation with files' });
    });

    const AT = 'must name a required string property with format uuid';
    const cases: [string, Record<string, unknown>][] = [
      ['a parent that is not type: object', obj({ entry: obj({ content: { type: 'string' } }, ['content']) }, ['entry'])],
      ['a segment missing from required', obj({ entry: obj({ content: obj({ data: { type: 'string', format: 'uuid' } }, ['data']) }, []) }, ['entry'])],
      ['a leaf without format uuid', obj({ entry: obj({ content: obj({ data: { type: 'string' } }, ['data']) }, ['content']) }, ['entry'])],
      ['a leaf that is not a string', obj({ entry: obj({ content: obj({ data: { type: 'integer', format: 'uuid' } }, ['data']) }, ['content']) }, ['entry'])],
    ];
    for (const [name, schema] of cases) {
      it(`OPS-8 refuses ${name}`, async () => {
        await refused(operation({ input_schema: schema }), 'operations[0].files[0].at', AT);
      });
    }

    it('OPS-8 accepts a leaf with title and description besides type and format', async () => {
      const schema = obj({ entry: obj({ content: obj({ data: { type: 'string', format: 'uuid', title: 'File', description: 'The file.' } }, ['data']) }, ['content']) }, ['entry']);
      ok(await loadOp(operation({ input_schema: schema })));
    });
  });

  describe('at', () => {
    for (const at of ['entry', '/', '/a//b', '/a/0', '/a/b/c/d/e/f/g/h/i', '/a~1b', '/a/', '']) {
      it(`OPS-8 refuses at ${JSON.stringify(at)}`, async () => {
        const result = found(await loadOp(operation({ files: [{ ...FILE, at }] })));
        expect(result).toEqual([expect.objectContaining({ file: 'ops.yaml', path: 'operations[0].files[0].at' })]);
      });
    }

    it('OPS-8 accepts eight segments', async () => {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      let schema: Record<string, unknown> = obj({ h: { type: 'string', format: 'uuid' } }, ['h']);
      for (const name of names.slice(0, 7).reverse()) schema = obj({ [name]: schema }, [name]);
      ok(await loadOp(operation({ input_schema: schema, files: [{ ...FILE, at: `/${names.join('/')}` }] })));
    });

    it('OPS-8 refuses a path equal to an earlier one', async () => {
      const two = { ...FILE, media_types: ['image/jpeg'] };
      await refused(operation({ files: [FILE, two] }), 'operations[0].files[1].at', 'must not repeat or extend another file path');
    });

    it('OPS-8 refuses a path that extends an earlier one', async () => {
      const schema = obj({ a: { type: 'string', format: 'uuid' } }, ['a']);
      const result = found(await loadOp(operation({ input_schema: schema, files: [{ ...FILE, at: '/a' }, { ...FILE, at: '/a/b' }] })));
      expect(result).toContainEqual({ file: 'ops.yaml', path: 'operations[0].files[1].at', message: 'must not repeat or extend another file path' });
    });
  });

  describe('entries', () => {
    it('OPS-8 refuses six entries and none', async () => {
      const six = Array.from({ length: 6 }, () => FILE);
      expect(found(await loadOp(operation({ files: six })))).toEqual([expect.objectContaining({ path: 'operations[0].files' })]);
      expect(found(await loadOp(operation({ files: [] })))).toEqual([expect.objectContaining({ path: 'operations[0].files' })]);
    });

    it('OPS-8 refuses empty media_types, an upper-case type and a malformed type', async () => {
      for (const media_types of [[], ['Image/PNG'], ['image'], ['image/png/x'], Array.from({ length: 21 }, (_, i) => `image/t${String(i)}`)]) {
        const result = found(await loadOp(operation({ files: [{ ...FILE, media_types }] })));
        expect(result).toEqual([expect.objectContaining({ file: 'ops.yaml', path: expect.stringMatching(/^operations\[0\]\.files\[0\]\.media_types/) as string })]);
      }
    });

    it('OPS-8 refuses max_bytes above files.max_bytes, the global or its default', async () => {
      await refused(operation({ files: [{ ...FILE, max_bytes: 5000 }] }), 'operations[0].files[0].max_bytes', 'must not exceed files.max_bytes', { 'g.yaml': doc({ files: { max_bytes: 4000 } }) });
      await refused(operation({ files: [{ ...FILE, max_bytes: 10_485_761 }] }), 'operations[0].files[0].max_bytes', 'must not exceed files.max_bytes');
    });

    it('OPS-8 refuses part with send: base64', async () => {
      await refused(operation({ files: [{ ...FILE, part: 'attachment' }] }), 'operations[0].files[0].part', 'is allowed only with send: multipart');
    });

    it('OPS-8 refuses unknown keys and a send other than base64', async () => {
      expect(found(await loadOp(operation({ files: [{ ...FILE, extra: 1 }] })))).toEqual([expect.objectContaining({ path: 'operations[0].files[0]' })]);
      expect(found(await loadOp(operation({ files: [{ ...FILE, send: 'raw' }] })))).toEqual([expect.objectContaining({ path: 'operations[0].files[0].send' })]);
    });
  });

  describe('grants', () => {
    const roles = (scope: Record<string, unknown>): string =>
      doc({ roles: [{ id: 'uploader', approval: { required: 'never' }, grants: [{ operation: 'media.upload', scope }] }], role_mapping: [{ group: 'up', roles: ['uploader'] }] });
    const imageSchema = obj({ image: { type: 'string', format: 'uuid' }, folder: { type: 'string' } }, ['image', 'folder']);
    const op = operation({ upstream: { method: 'POST', path: '/V1/media', query: { folder: { arg: 'folder' } } }, input_schema: imageSchema, files: [{ ...FILE, at: '/image' }] });

    it('OPS-8 refuses a grant scope that names a one-segment file argument', async () => {
      const result = found(await loadOp(op, { 'roles.yaml': roles({ image: ['x'] }) }));
      expect(result).toContainEqual({ file: 'roles.yaml', path: 'roles[0].grants[0].scope.image', message: 'names a file argument' });
    });

    it('OPS-8 allows a grant scope on another argument', async () => {
      ok(await loadOp(op, { 'roles.yaml': roles({ folder: ['x'] }) }));
    });
  });

  describe('global files settings', () => {
    it('OPS-8 files may be set in one document only', async () => {
      const result = found(await load({ 'a.yaml': doc({ files: { keep_days: 3 } }), 'b.yaml': doc({ files: { keep_days: 4 } }) }));
      expect(result).toEqual([{ file: 'b.yaml', path: 'files', message: 'may be set in one document only; first set in a.yaml' }]);
    });

    it('OPS-8 settings fill key by key', async () => {
      const config = ok(await load({ 'a.yaml': doc({ files: { staged_ttl_hours: 2, per_user_count: 3, per_user_bytes: 4 } }) }));
      expect(config.files).toEqual({ ...DEFAULT_FILE_SETTINGS, stagedTtlHours: 2, perUserCount: 3, perUserBytes: 4 });
    });

    const bad: [string, Record<string, number>][] = [
      ['max_bytes', { max_bytes: 26_214_401 }],
      ['max_bytes', { max_bytes: 0 }],
      ['keep_days', { keep_days: -1 }],
      ['keep_days', { keep_days: 366 }],
      ['per_user_count', { per_user_count: 0 }],
      ['per_user_count', { per_user_count: 1001 }],
      ['staged_ttl_hours', { staged_ttl_hours: 0 }],
      ['staged_ttl_hours', { staged_ttl_hours: 721 }],
      ['per_user_bytes', { per_user_bytes: 10_737_418_241 }],
    ];
    for (const [key, files] of bad) {
      it(`OPS-8 refuses ${JSON.stringify(files)}`, async () => {
        expect(found(await load({ 'a.yaml': doc({ files }) }))).toEqual([expect.objectContaining({ file: 'a.yaml', path: `files.${key}` })]);
      });
    }

    it('OPS-8 accepts the bounds', async () => {
      const config = ok(await load({ 'a.yaml': doc({ files: { max_bytes: 26_214_400, keep_days: 365, staged_ttl_hours: 720, per_user_count: 1000, per_user_bytes: 10_737_418_240 } }) }));
      expect(config.files.maxBytes).toBe(26_214_400);
    });

    it('OPS-8 refuses an unknown key', async () => {
      expect(found(await load({ 'a.yaml': doc({ files: { nope: 1 } }) }))).toEqual([expect.objectContaining({ path: 'files' })]);
    });
  });
});
