// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
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

const VERSION_LINES = [/^\/\/ @aiops\/connector-sdk \S+ public API report/, /^export declare const CONNECTOR_SDK_VERSION = ".*";?$/, /^\s*"x-aiops-schema-version":/];

/** Lines of a report as a multiset, without version-carrying lines and trailing commas. */
function surface(text) {
  const counts = new Map();
  for (const raw of text.split('\n')) {
    if (VERSION_LINES.some((re) => re.test(raw))) continue;
    const line = raw.replace(/\s+$/, '').replace(/,$/, '');
    if (line.trim() === '') continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function surplus(from, other) {
  let n = 0;
  for (const [line, c] of from) n += Math.max(0, c - (other.get(line) ?? 0));
  return n;
}

/** Judges a report change against the version bump. A changed line counts as removed plus added. */
export function judge(oldText, newText, oldVersion, newVersion) {
  const a = surface(oldText);
  const b = surface(newText);
  const removed = surplus(a, b);
  const added = surplus(b, a);
  const kind = removed > 0 ? 'breaking' : added > 0 ? 'additive' : 'none';
  if (kind === 'none') return { ok: true, kind, message: 'no change to the public surface' };
  const o = parse(oldVersion);
  const n = parse(newVersion);
  if (!o || !n) return { ok: false, kind, message: `invalid version (${oldVersion} -> ${newVersion})` };
  const major = n.major > o.major;
  const minor = major || (n.major === o.major && n.minor > o.minor);
  if (kind === 'breaking') {
    return major
      ? { ok: true, kind, message: `breaking change, major bump ${oldVersion} -> ${newVersion}` }
      : { ok: false, kind, message: `breaking change needs a major bump (${oldVersion} -> ${newVersion})` };
  }
  return minor
    ? { ok: true, kind, message: `additive change, bump ${oldVersion} -> ${newVersion}` }
    : { ok: false, kind, message: `additive change needs a minor bump (${oldVersion} -> ${newVersion})` };
}
