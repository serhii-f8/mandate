// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Semver gate over the public surface reports (NFR-18). Pure functions; no process access.
import { headerVersion } from './api-report-lib.mjs';

/** Parses `x.y.z[-pre]`; returns undefined for anything else. */
function parse(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '');
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] } : undefined;
}

/** The version a report carries (SDK header comment or the config schema's version key). */
export function versionOf(report, kind) {
  const v = headerVersion(report);
  if (v === undefined) throw new Error(`${kind} report carries no version`);
  return v;
}

const VERSION_LINES = [
  /^\/\/ @mandate\/connector-sdk \S+ public API report/,
  /^export declare const CONNECTOR_SDK_VERSION = ".*";?$/,
  /^\s*"x-mandate-(schema|sdk)-version":/,
];

/**
 * JSON Schema keywords whose addition to an existing schema object narrows what it accepts.
 * Values added inside an existing `enum` array widen it and are not matched here.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format',
  'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'const', 'not', 'enum',
  'additionalProperties', 'required', 'type', 'allOf', 'anyOf', 'oneOf', '$ref', 'items', 'prefixItems',
  'propertyNames', 'patternProperties', 'dependentRequired',
]);
const JSON_KEY = /^"((?:[^"\\]|\\.)*)":/;
/** An optional member of a .d.ts type body: `name?: T`, `readonly name?: T`, `name?(…)`, `'a-b'?: T`. */
const OPTIONAL_MEMBER = /^(?:readonly\s+)?(?:[\w$]+|'[^']*'|"[^"]*")\?\s*[:(<]/;
const DECL = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|class)\s/;

const SEP = '\u0000';

/**
 * Lines of a report keyed by their context: the path of enclosing opener lines. A line ending
 * with `{` or `[` opens a frame, a line starting with `}` or `]` closes one (`} | {` closes and
 * reopens: the next variant of the same declaration, as does a root line `| {` or `& {` right
 * after a declaration closed). Closing lines belong to the frame they
 * close. Repeated identical openers under one parent (array elements, overloads) are numbered.
 * Each entry records its frame path and the frame kind (`interface`, `literal`, `class`, `other`).
 */
function surface(text) {
  const root = { label: '', path: '', kind: 'root', children: new Map() };
  const stack = [root];
  const entries = [];
  const frames = new Set(['']);
  const push = (label, kind) => {
    const parent = stack[stack.length - 1];
    const n = parent.children.get(label) ?? 0;
    parent.children.set(label, n + 1);
    const path = `${parent.path}${SEP}${label}#${n}`;
    const frame = { label, path, kind, children: new Map(), base: label, variant: 0 };
    stack.push(frame);
    frames.add(path);
    return frame;
  };
  const variantOf = (closed) => {
    const parent = stack[stack.length - 1];
    const variant = closed.variant + 1;
    const label = `${closed.base} |${variant}`;
    const path = `${parent.path}${SEP}${label}`;
    stack.push({ label, path, kind: closed.kind, children: new Map(), base: closed.base, variant });
    frames.add(path);
  };
  // The last declaration closed at the root: a following root line `| {` or `& {` continues it.
  let lastClosed;
  for (const raw of text.split('\n')) {
    if (VERSION_LINES.some((re) => re.test(raw))) continue;
    const line = raw.trim().replace(/,$/, '');
    if (line === '') continue;
    const closes = (line.startsWith('}') || line.startsWith(']')) && stack.length > 1;
    const opens = line.endsWith('{') || line.endsWith('[');
    const top = stack[stack.length - 1];
    if (stack.length === 1 && lastClosed && /^[|&]/.test(line) && opens) {
      entries.push({ key: `${lastClosed.path}${SEP}${line}`, line, frame: lastClosed, parent: top });
      variantOf(lastClosed);
      lastClosed = undefined;
      continue;
    }
    entries.push({ key: `${top.path}${SEP}${line}`, line, frame: top, parent: stack[stack.length - 2] });
    if (stack.length === 1) lastClosed = undefined;
    if (closes) {
      const closed = stack.pop();
      if (opens) variantOf(closed);
      else if (stack.length === 1) lastClosed = closed;
    } else if (opens) {
      const parentKind = top.kind;
      let kind = 'other';
      if (parentKind === 'root') {
        const m = DECL.exec(line);
        kind = m ? (m[1] === 'type' ? 'literal' : m[1]) : 'other';
      } else if (parentKind === 'interface' || parentKind === 'literal') {
        kind = 'literal';
      }
      push(line, kind);
    }
  }
  return { entries, frames };
}

function counts(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.key, (m.get(e.key) ?? 0) + 1);
  return m;
}

/** Why an added entry narrows the surface, or undefined when it is a pure addition. */
function narrowing(entry, oldFrames) {
  const { line, frame, parent } = entry;
  const existed = (f) => f !== undefined && oldFrames.has(f.path);
  // A JSON key listed in an existing schema's `required` array.
  if (frame.label.startsWith('"required": [') && existed(parent)) return `newly required ${line}`;
  // Every element of an existing `allOf` must hold, so a new element narrows.
  if (frame.label.startsWith('"allOf": [') && existed(frame)) return `allOf element added ${line}`;
  const key = JSON_KEY.exec(line);
  if (key && CONSTRAINT_KEYWORDS.has(key[1]) && existed(frame)) return `constraint added ${line}`;
  // A member consumers must now provide, inside an existing interface or type-literal body.
  if ((frame.kind === 'interface' || frame.kind === 'literal') && existed(frame) && !OPTIONAL_MEMBER.test(line)) {
    // Closers, and the opener of a further union or intersection variant (judged like `} | {`).
    if (line.startsWith('}') || line.startsWith(']') || (/^[|&]/.test(line) && line.endsWith('{'))) return undefined;
    return `required member added ${line}`;
  }
  return undefined;
}

/** Splits the change into removed entries and added entries, each added one with its narrowing reason. */
function compare(oldText, newText) {
  const a = surface(oldText);
  const b = surface(newText);
  const ca = counts(a.entries);
  const cb = counts(b.entries);
  const removed = [];
  for (const e of a.entries) {
    const left = cb.get(e.key) ?? 0;
    if (left > 0) cb.set(e.key, left - 1);
    else removed.push(e.line);
  }
  const added = [];
  const narrowed = [];
  for (const e of b.entries) {
    const left = ca.get(e.key) ?? 0;
    if (left > 0) {
      ca.set(e.key, left - 1);
      continue;
    }
    added.push(e.line);
    const why = narrowing(e, a.frames);
    if (why) narrowed.push(why);
  }
  return { removed, added, narrowed };
}

function compareVersions(o, n) {
  for (const k of ['major', 'minor', 'patch']) if (o[k] !== n[k]) return o[k] < n[k] ? -1 : 1;
  if (o.pre === n.pre) return 0;
  if (o.pre === undefined) return 1;
  if (n.pre === undefined) return -1;
  const x = o.pre.split('.');
  const y = n.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Judges a report change against the version bump (NFR-18). Breaking: any removed or changed
 * line (lines are compared within their context), or an added line that narrows the surface
 * (a newly required key or member, an added schema constraint). Additive: other added lines.
 * Deliberately conservative; it backs up review and does not replace it.
 */
export function judge(oldText, newText, oldVersion, newVersion) {
  const { removed, added, narrowed } = compare(oldText, newText);
  const kind = removed.length > 0 || narrowed.length > 0 ? 'breaking' : added.length > 0 ? 'additive' : 'none';
  const o = parse(oldVersion);
  const n = parse(newVersion);
  if (!o || !n) return { ok: false, kind, message: `invalid version (${oldVersion} -> ${newVersion})` };
  if (kind === 'none') {
    return compareVersions(o, n) > 0
      ? { ok: false, kind, message: `version goes down (${oldVersion} -> ${newVersion})` }
      : { ok: true, kind, message: 'no change to the public surface' };
  }
  const major = n.major > o.major;
  const minor = major || (n.major === o.major && n.minor > o.minor);
  const first = removed.length > 0 ? `removed or changed: ${removed[0]}` : narrowed[0] ?? added[0];
  if (kind === 'breaking') {
    return major
      ? { ok: true, kind, message: `breaking change, major bump ${oldVersion} -> ${newVersion}` }
      : { ok: false, kind, message: `breaking change needs a major bump (${oldVersion} -> ${newVersion}); first: ${first}` };
  }
  return minor
    ? { ok: true, kind, message: `additive change, bump ${oldVersion} -> ${newVersion}` }
    : { ok: false, kind, message: `additive change needs a minor bump (${oldVersion} -> ${newVersion}); first: ${first}` };
}
