// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import type { ChangeSetRecord } from '../changeset/model.js';
import type { FileArgument, FileDescriptor, FileLink } from './model.js';
import type { FileStore } from './ports.js';

/** The only key of the object that stands for a file in stored arguments (CS-10). */
export const FILE_KEY = '$file';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

export function sha256Of(content: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

/** The decoded file name, or undefined when it is not allowed (1..255 code points, no control character, no slash, not . or ..). */
export function parseFileName(raw: string): string | undefined {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const length = Array.from(name).length;
  if (length < 1 || length > 255) return undefined;
  if (/\p{Cc}/u.test(name) || name.includes('/') || name.includes('\\')) return undefined;
  if (name === '.' || name === '..') return undefined;
  return name;
}

/** The lower-cased type/subtype of a Content-Type value without parameters, or undefined. */
export function parseMediaType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const type = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : undefined;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function valueAt(args: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let cur: unknown = args;
  for (const key of path) {
    if (!isPlain(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};

/** The descriptor at `path` when the value there has exactly the descriptor shape; else undefined. */
export function fileDescriptorAt(args: Readonly<Record<string, unknown>>, path: readonly string[]): FileDescriptor | undefined {
  const wrapper = valueAt(args, path);
  if (!isPlain(wrapper) || !hasExactKeys(wrapper, [FILE_KEY])) return undefined;
  const d = wrapper[FILE_KEY];
  if (!isPlain(d) || !hasExactKeys(d, ['id', 'name', 'media_type', 'size', 'sha256'])) return undefined;
  const { id, name, media_type: mediaType, size, sha256 } = d;
  if (typeof id !== 'string' || !UUID.test(id)) return undefined;
  if (typeof name !== 'string' || typeof mediaType !== 'string') return undefined;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined;
  return { id, name, media_type: mediaType, size, sha256 };
}

/** Marks `withValueAt` to remove the property instead of setting it. */
export const OMIT: unique symbol = Symbol('omit');

/** Defines `key` as an own data property, so a `__proto__` segment (OPS-8 admits it) never reaches the prototype setter. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

/** A copy of `args` with the value at `path` replaced, or the property removed when `value` is `OMIT`; only the objects on the path are copied. Throws TypeError when a parent on the path is not a plain object. */
export function withValueAt(args: Readonly<Record<string, unknown>>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) throw new TypeError('empty path');
  const copy: Record<string, unknown> = { ...args };
  if (rest.length === 0) {
    if (value === OMIT) return Object.fromEntries(Object.entries(copy).filter(([k]) => k !== head)); // fromEntries defines own properties
    return setOwn(copy, head, value);
  }
  const child = Object.prototype.hasOwnProperty.call(args, head) ? args[head] : undefined;
  if (!isPlain(child)) throw new TypeError('a parent on the path is not an object');
  return setOwn(copy, head, withValueAt(child, rest, value));
}

export type FileRefusal = 'file_not_found' | 'file_too_large' | 'file_type_not_allowed';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Replaces each declared file ID with its descriptor (CS-10); the first refusal in declaration order wins. */
export async function resolveFileArgs(input: {
  files: readonly FileArgument[];
  args: Readonly<Record<string, unknown>>;
  owner: string;
  store: Pick<FileStore, 'get'>;
}): Promise<{ ok: true; args: Record<string, unknown>; links: readonly FileLink[] } | { ok: false; code: FileRefusal; pointer: string }> {
  let args: Record<string, unknown> = { ...input.args };
  const links: FileLink[] = [];
  for (const entry of input.files) {
    const refuse = (code: FileRefusal) => ({ ok: false as const, code, pointer: entry.pointer });
    const raw = valueAt(input.args, entry.path);
    if (typeof raw !== 'string' || !UUID.test(raw)) return refuse('file_not_found');
    const id = raw.toLowerCase();
    const file = await input.store.get(id);
    if (file?.owner !== input.owner || file.purgedAt !== undefined) return refuse('file_not_found');
    if (file.size > entry.maxBytes) return refuse('file_too_large');
    if (!entry.mediaTypes.includes(file.mediaType)) return refuse('file_type_not_allowed');
    const descriptor: FileDescriptor = { id: file.id, name: file.name, media_type: file.mediaType, size: file.size, sha256: file.sha256 };
    args = withValueAt(args, entry.path, { [FILE_KEY]: descriptor });
    links.push({ pointer: entry.pointer, fileId: file.id });
  }
  links.sort((a, b) => byCodePoint(a.pointer, b.pointer));
  return { ok: true, args, links };
}

/** Whether the change-set's stored links and descriptors are exactly what `files` declares: same pointers, a descriptor at each, its `id` the linked file. Both empty is true. */
export function storedFilesMatch(files: readonly FileArgument[] | undefined, changeset: Pick<ChangeSetRecord, 'args' | 'files'>): boolean {
  const declared = files ?? [];
  const links = changeset.files ?? [];
  if (declared.length !== links.length) return false;
  const linked = new Map(links.map((l) => [l.pointer, l.fileId]));
  if (linked.size !== links.length) return false;
  for (const entry of declared) {
    const fileId = linked.get(entry.pointer);
    if (fileId === undefined) return false;
    const d = fileDescriptorAt(changeset.args, entry.path);
    if (d?.id !== fileId) return false;
  }
  return true;
}
