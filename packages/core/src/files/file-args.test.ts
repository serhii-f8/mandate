// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import {
  OMIT,
  fileDescriptorAt,
  parseFileName,
  parseMediaType,
  resolveFileArgs,
  sha256Of,
  storedFilesMatch,
  withValueAt,
} from './file-args.js';
import type { FileArgument, StagedFile } from './model.js';

const F = '0b0e6f3a-1111-4222-8333-444455556666';
const G = '0b0e6f3a-1111-4222-8333-444455557777';
const files: readonly FileArgument[] = [
  { pointer: '/entry/content/data', path: ['entry', 'content', 'data'], send: 'base64', mediaTypes: ['image/png'], maxBytes: 100 },
];
const staged: StagedFile = {
  id: F,
  owner: 'alice',
  name: 'a.png',
  mediaType: 'image/png',
  size: 10,
  sha256: 'sha256:' + 'ab'.repeat(32),
  preview: 'image',
  createdAt: new Date(0),
};
const storeOf = (file: StagedFile) => ({ get: (id: string) => Promise.resolve(id === F ? file : undefined) });
const args = { sku: 'A', entry: { label: 'x', content: { data: F.toUpperCase() } } };

describe('OPS-8 CS-10 file arguments', () => {
  it('parses file names', () => {
    expect(parseFileName('caf%C3%A9.png')).toBe('café.png');
    for (const bad of ['', '..', '.', 'a%2Fb', 'a%5Cb', 'a%0Ab', '%E0%A4%A', 'x'.repeat(256)]) {
      expect(parseFileName(bad)).toBeUndefined();
    }
    expect(parseFileName('x'.repeat(255))).toBe('x'.repeat(255));
  });

  it('parses media types', () => {
    expect(parseMediaType('Image/PNG; charset=x')).toBe('image/png');
    for (const bad of [undefined, '', 'png', 'image/', 'image/p ng']) expect(parseMediaType(bad)).toBeUndefined();
  });

  it('hashes content', () => {
    expect(sha256Of(new Uint8Array())).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('resolves a file argument into a descriptor and a link without mutating the input', async () => {
    const ok = await resolveFileArgs({ files, args, owner: 'alice', store: storeOf(staged) });
    expect(ok).toEqual({
      ok: true,
      links: [{ pointer: '/entry/content/data', fileId: F }],
      args: {
        sku: 'A',
        entry: {
          label: 'x',
          content: { data: { $file: { id: F, name: 'a.png', media_type: 'image/png', size: 10, sha256: staged.sha256 } } },
        },
      },
    });
    expect(args.entry.content.data).toBe(F.toUpperCase());
  });

  it('refuses another owner, a purged file, a non-UUID, a large file and a wrong type', async () => {
    const at = '/entry/content/data';
    expect(await resolveFileArgs({ files, args, owner: 'bob', store: storeOf(staged) })).toEqual({ ok: false, code: 'file_not_found', pointer: at });
    expect(await resolveFileArgs({ files, args, owner: 'alice', store: storeOf({ ...staged, purgedAt: new Date(1) }) })).toEqual({ ok: false, code: 'file_not_found', pointer: at });
    const bad = { entry: { content: { data: 'not-a-uuid' } } };
    expect(await resolveFileArgs({ files, args: bad, owner: 'alice', store: storeOf(staged) })).toEqual({ ok: false, code: 'file_not_found', pointer: at });
    const missing = { entry: { content: { data: G } } };
    expect(await resolveFileArgs({ files, args: missing, owner: 'alice', store: storeOf(staged) })).toEqual({ ok: false, code: 'file_not_found', pointer: at });
    expect(await resolveFileArgs({ files, args, owner: 'alice', store: storeOf({ ...staged, size: 101 }) })).toEqual({ ok: false, code: 'file_too_large', pointer: at });
    expect(await resolveFileArgs({ files, args, owner: 'alice', store: storeOf({ ...staged, mediaType: 'image/gif' }) })).toEqual({ ok: false, code: 'file_type_not_allowed', pointer: at });
  });

  it('orders links by pointer and reports the first refusal in declaration order', async () => {
    const two: readonly FileArgument[] = [
      { pointer: '/b', path: ['b'], send: 'multipart', mediaTypes: ['image/png'], maxBytes: 100, part: 'b' },
      { pointer: '/a', path: ['a'], send: 'multipart', mediaTypes: ['image/png'], maxBytes: 100, part: 'a' },
    ];
    const ok = await resolveFileArgs({ files: two, args: { a: F, b: F }, owner: 'alice', store: storeOf(staged) });
    expect(ok.ok && ok.links.map((l) => l.pointer)).toEqual(['/a', '/b']);
    const refused = await resolveFileArgs({ files: two, args: { a: 'x', b: 'y' }, owner: 'alice', store: storeOf(staged) });
    expect(refused).toEqual({ ok: false, code: 'file_not_found', pointer: '/b' });
  });

  it('matches stored files against the operation declaration', async () => {
    const ok = await resolveFileArgs({ files, args, owner: 'alice', store: storeOf(staged) });
    if (!ok.ok) throw new Error('expected ok');
    const cs = { args: ok.args, files: ok.links };
    expect(storedFilesMatch(files, cs)).toBe(true);
    expect(storedFilesMatch(files, { args: ok.args, files: [] })).toBe(false);
    expect(storedFilesMatch(files, { args: ok.args })).toBe(false);
    expect(storedFilesMatch(files, { args: ok.args, files: [{ pointer: '/other', fileId: F }] })).toBe(false);
    expect(storedFilesMatch(files, { args: ok.args, files: [{ pointer: '/entry/content/data', fileId: G }] })).toBe(false);
    expect(storedFilesMatch(files, { args, files: ok.links })).toBe(false);
    expect(storedFilesMatch(undefined, cs)).toBe(false);
    expect(storedFilesMatch(undefined, { args: { sku: 'A' } })).toBe(true);
    expect(storedFilesMatch([], { args: { sku: 'A' }, files: [] })).toBe(true);
    expect(storedFilesMatch(files, { args: { sku: 'A' } })).toBe(false);
  });

  it('reads a descriptor only in its exact shape', () => {
    const d = { id: F, name: 'a.png', media_type: 'image/png', size: 10, sha256: staged.sha256 };
    expect(fileDescriptorAt({ x: { $file: d } }, ['x'])).toEqual(d);
    expect(fileDescriptorAt({ x: { $file: d, extra: 1 } }, ['x'])).toBeUndefined();
    expect(fileDescriptorAt({ x: { $file: { ...d, extra: 1 } } }, ['x'])).toBeUndefined();
    expect(fileDescriptorAt({ x: { $file: { ...d, size: 1.5 } } }, ['x'])).toBeUndefined();
    expect(fileDescriptorAt({ x: { $file: { ...d, sha256: 'abc' } } }, ['x'])).toBeUndefined();
    expect(fileDescriptorAt({ x: F }, ['x'])).toBeUndefined();
    expect(fileDescriptorAt({ x: 1 }, ['x', 'y'])).toBeUndefined();
  });

  it('replaces or omits a value, copying only the path', () => {
    const out = withValueAt(args, ['entry', 'content', 'data'], OMIT);
    expect(out).toEqual({ sku: 'A', entry: { label: 'x', content: {} } });
    expect(args.entry.content.data).toBe(F.toUpperCase());
    const same = withValueAt(args, ['entry', 'content', 'data'], 'v');
    expect(same.sku).toBe('A');
    expect((same.entry as { label: string }).label).toBe('x');
    expect(() => withValueAt({ entry: 'str' }, ['entry', 'x'], 1)).toThrow(TypeError);
    expect(() => withValueAt({}, ['entry', 'x'], 1)).toThrow(TypeError);
  });

  it('OPS-8 a __proto__ path segment sets and reads an own property, never the prototype', () => {
    const d = { id: F, name: 'a.png', media_type: 'image/png', size: 10, sha256: staged.sha256 };
    const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
    const set = withValueAt({}, ['__proto__'], 'v');
    expect(own(set, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(set)).toBe(Object.prototype);
    const nested = JSON.parse('{"__proto__":{"k":1}}') as Record<string, unknown>;
    const deep = withValueAt(nested, ['__proto__', 'k'], 'v');
    expect(Object.getPrototypeOf(deep)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(deep, '__proto__')?.value).toEqual({ k: 'v' });
    expect(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value).toEqual({ k: 1 });
    expect(own(withValueAt(set, ['__proto__'], OMIT), '__proto__')).toBe(false);
    // Reading: an inherited `__proto__` is no value; an own one is.
    expect(fileDescriptorAt({}, ['__proto__'])).toBeUndefined();
    const holder = JSON.parse(JSON.stringify({ x: 1 }).replace('{"x":1}', `{"__proto__":{"$file":${JSON.stringify(d)}}}`)) as Record<string, unknown>;
    expect(fileDescriptorAt(holder, ['__proto__'])).toEqual(d);
  });
});
