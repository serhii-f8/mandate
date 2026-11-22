// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preset packages (CONN-8): finding every installed copy of a package in the preset
 * directories, choosing a version by semver range, and reading the `mandate` field of its
 * `package.json`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { PARSE_PARAMS, schemaIssues } from './schema.js';

export interface MandateField {
  readonly preset: string;
  readonly sdk: string;
  readonly code?: string;
}

export interface PackageCandidate {
  readonly dir: string;
  readonly version: string;
  /** The `package.json` text, covered by the configuration hash. */
  readonly packageJson: string;
  readonly mandate?: MandateField;
}

const relativePath = z.string().min(1).max(1024);

/** The `mandate` block of a preset's package.json; exported for the public preset report (NFR-18). */
export const presetMandateSchema = z.strictObject({
  preset: relativePath.default('preset.yaml'),
  sdk: z
    .string()
    .min(1)
    .max(256)
    .refine((range) => semver.validRange(range) !== null, { message: 'must be a semver range' }),
  code: relativePath.optional(),
});

const packageJsonSchema = z.object({ name: z.string(), version: z.string() });

/** `mandate` of a parsed package.json, or the issues (paths under `mandate`). */
export function parseMandateField(
  json: unknown,
): { ok: true; mandate?: MandateField } | { ok: false; issues: readonly { path: readonly PropertyKey[]; message: string }[] } {
  if (typeof json !== 'object' || json === null || !('mandate' in json)) return { ok: true };
  const result = presetMandateSchema.safeParse(json.mandate, PARSE_PARAMS);
  if (!result.success) return { ok: false, issues: schemaIssues(result).map((issue) => ({ path: ['mandate', ...issue.path], message: issue.message })) };
  const { preset, sdk, code } = result.data;
  return { ok: true, mandate: { preset, sdk, ...(code === undefined ? {} : { code }) } };
}

/** Highest candidate satisfying `range` (undefined: any); first directory wins on equal versions. */
export async function selectPackage(name: string, range: string | undefined, dirs: readonly string[]): Promise<PackageCandidate | undefined> {
  let best: PackageCandidate | undefined;
  for (const root of dirs) {
    for (const candidate of await candidatesNamed(name, root)) {
      if (semver.valid(candidate.version) === null) continue;
      if (!semver.satisfies(candidate.version, range ?? '*', { includePrerelease: false })) continue;
      // Strictly greater only, so the earlier directory keeps an equal version.
      if (best === undefined || semver.rcompare(candidate.version, best.version) < 0) best = candidate;
    }
  }
  return best;
}

/** Packages under `root` whose `package.json` has the name, in directory listing order. */
async function candidatesNamed(name: string, root: string): Promise<PackageCandidate[]> {
  const out: PackageCandidate[] = [];
  for (const dir of await packageDirs(root)) {
    let text: string;
    try {
      text = await readFile(join(dir, 'package.json'), 'utf8');
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue; // not a preset package
    }
    const pkg = packageJsonSchema.safeParse(json);
    if (!pkg.success || pkg.data.name !== name) continue;
    // An invalid `mandate` field stays a candidate: the loader reports its issues.
    const mandate = parseMandateField(json);
    out.push({ dir, version: pkg.data.version, packageJson: text, ...(mandate.ok && mandate.mandate !== undefined ? { mandate: mandate.mandate } : {}) });
  }
  return out;
}

/**
 * Package directories directly under `root` and its `@scope` directories, then the same
 * under `root/node_modules` (an `npm install` layout; entries may be symbolic links).
 * Hidden entries such as pnpm's `.pnpm` store are skipped.
 */
async function packageDirs(root: string): Promise<string[]> {
  const list = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return [];
    }
  };
  const level = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const name of await list(dir)) {
      if (name.startsWith('@')) for (const child of await list(join(dir, name))) out.push(join(dir, name, child));
      else if (name !== 'node_modules') out.push(join(dir, name));
    }
    return out;
  };
  return [...(await level(root)), ...(await level(join(root, 'node_modules')))];
}
