// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Preset resolution (CONN-8; design part 1 §3.4, ADR 0017; Phase 9 packages): a preset is a
 * package directory in one of the preset directories, chosen by its `package.json` name and
 * a semver range, holding a preset file (`aiops.preset`, default `preset.yaml`) and, for an
 * openapi preset, a vendored spec. Issues inside the preset are reported with the file
 * `<package>/<preset file>` (CFG-2), issues about `aiops` with `<package>/package.json`.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CONNECTOR_SDK_VERSION } from '@aiops/connector-sdk';
import semver from 'semver';
import { z } from 'zod';
import { pathToString, type ConfigIssue } from './issues.js';
import { loadPresetCode, type ImportModule, type LoadedPresetCode } from './preset-code.js';
import { parseAiopsField, selectPackage } from './preset-package.js';
import { PARSE_PARAMS, presetOperationSchema, schemaIssues, type PresetConfig, type PresetOperationConfig } from './schema.js';
import { findSecretKeys, SECRET_MESSAGE } from './secrets.js';
import { authSchema, connectionTestSchema, isSpecUrl, type AuthConfig, type ConnectionTestConfig } from './upstream-schema.js';
import { parseYamlSource, type SourceDocument } from './yaml-source.js';

export const presetDocumentSchema = z.strictObject({
  version: z.literal(1),
  /** The connection adapter the preset is for (CONN-8). */
  adapter: z.enum(['openapi', 'mcp']).default('openapi'),
  /** The vendored spec, relative to the preset directory: required for openapi, refused for mcp. */
  spec: z.string().min(1).max(1024).optional(),
  /** Default auth for connections that bind the preset without their own. */
  auth: authSchema.optional(),
  test: connectionTestSchema.optional(),
  operations: z.array(presetOperationSchema).default([]),
});

export interface LoadedPreset {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  /** The connection adapter the preset is for. */
  readonly adapter: 'openapi' | 'mcp';
  /** Absolute directory of the preset package. */
  readonly dir: string;
  /** The preset file (`aiops.preset`, default `preset.yaml`), named `<package>/<path>` in issues. */
  readonly source: SourceDocument;
  /** Absolute path of the vendored spec; an mcp preset has none. */
  readonly specFile?: string;
  /** `aiops.sdk` of the package; absent for a package without `aiops`. */
  readonly sdk?: string;
  readonly auth?: AuthConfig;
  readonly test?: ConnectionTestConfig;
  readonly operations: readonly PresetOperationConfig[];
  /** `package.json`, the preset file and the spec (openapi only), in this order; covered by the configuration hash. */
  readonly files: readonly { readonly file: string; readonly text: string }[];
  /** The code module of `aiops.code` (OPS-5); its tree digest is covered by the configuration hash (CFG-4). */
  readonly code?: LoadedPresetCode;
}

export type PresetResult = { ok: true; preset: LoadedPreset } | { ok: false; issues: ConfigIssue[] };

/** Where the `presets` entry is declared, so issues about it point there. */
export interface PresetEntryLocation {
  readonly source: SourceDocument;
  readonly path: readonly PropertyKey[];
}

/** The adapter's spec size limit (design part 1 §4.2); larger files are not read for the hash either. */
export const MAX_SPEC_FILE_BYTES = 5 * 1024 * 1024;

/** Reads a spec file for the configuration hash, or says why it cannot (a value-free message). */
export async function readSpecFile(path: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: 'spec file cannot be read' };
    if (info.size > MAX_SPEC_FILE_BYTES) return { ok: false, message: 'spec file exceeds 5 MB' };
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch {
    return { ok: false, message: 'spec file cannot be read' };
  }
}

export interface ResolvePresetOptions {
  /** How the code module is imported; native `import()` when absent (see `LoadOptions.importModule`). */
  readonly importModule?: ImportModule;
}

export async function resolvePreset(
  entry: PresetConfig,
  dirs: readonly string[],
  declared?: PresetEntryLocation,
  options: ResolvePresetOptions = {},
): Promise<PresetResult> {
  const entryIssue = (key: 'package' | 'version', message: string): ConfigIssue => {
    if (declared === undefined) return { file: '.', path: pathToString(['presets', entry.id, key]), message };
    const path = [...declared.path, key];
    return { file: declared.source.file, path: pathToString(path), ...(declared.source.locate(path) ?? {}), message };
  };

  if (entry.version !== undefined && semver.validRange(entry.version) === null) {
    return { ok: false, issues: [entryIssue('version', 'must be a semver version or range')] };
  }
  const found = await selectPackage(entry.package, entry.version, dirs);
  if (found === undefined) {
    const installed = entry.version !== undefined && (await selectPackage(entry.package, undefined, dirs)) !== undefined;
    return { ok: false, issues: [installed ? entryIssue('version', 'does not match the installed package version') : entryIssue('package', 'is not installed in the preset directories')] };
  }

  // The `aiops` field (CONN-8, NFR-18); issues name `<package>/package.json`.
  const packageFile = `${entry.package}/package.json`;
  const packageIssue = (key: string, message: string): PresetResult => ({ ok: false, issues: [{ file: packageFile, path: `aiops.${key}`, message }] });
  const aiopsField = parseAiopsField(JSON.parse(found.packageJson));
  if (!aiopsField.ok) return { ok: false, issues: aiopsField.issues.map((issue) => ({ file: packageFile, path: pathToString(issue.path), message: issue.message })) };
  const aiops = aiopsField.aiops;
  if (aiops !== undefined && !semver.satisfies(CONNECTOR_SDK_VERSION, aiops.sdk)) {
    return packageIssue('sdk', `preset_sdk_incompatible: the preset requires connector SDK ${aiops.sdk}; this platform provides ${CONNECTOR_SDK_VERSION}`);
  }

  const realDir = await realpath(found.dir);
  const presetPath = aiops?.preset ?? 'preset.yaml';
  const presetFile = resolve(found.dir, presetPath);
  if (isAbsolute(presetPath) || !isInside(found.dir, presetFile)) return packageIssue('preset', 'must be a path inside the preset');
  const file = `${entry.package}/${relative(found.dir, presetFile).split(sep).join('/')}`;
  let text: string;
  try {
    const realPreset = await realpath(presetFile);
    // A symbolic link may still point elsewhere: compare the real paths too.
    if (!isInside(realDir, realPreset)) return packageIssue('preset', 'must be a path inside the preset');
    text = await readFile(realPreset, 'utf8');
  } catch {
    return { ok: false, issues: [{ file, path: '', message: 'cannot be read' }] };
  }
  const parsed = parseYamlSource(file, text);
  const source = parsed.document;
  if (source === undefined) return { ok: false, issues: [...parsed.issues] };

  const issues: ConfigIssue[] = [];
  const at = (path: readonly PropertyKey[], message: string): void => {
    issues.push({ file, path: pathToString(path), ...(source.locate(path) ?? {}), message });
  };
  for (const path of findSecretKeys(source.value)) at(path, SECRET_MESSAGE);
  const result = presetDocumentSchema.safeParse(source.value ?? {}, PARSE_PARAMS);
  for (const issue of schemaIssues(result)) at(issue.path, issue.message);
  if (!result.success || issues.length > 0) return { ok: false, issues };
  const doc = result.data;

  const files = [
    { file: packageFile, text: found.packageJson },
    { file, text },
  ];
  let specFile: string | undefined;
  if (doc.adapter === 'mcp') {
    if (doc.spec !== undefined) at(['spec'], 'is not allowed for an mcp preset');
  } else if (doc.spec === undefined) at(['spec'], 'is required for an openapi preset');
  else {
    const spec = await readPresetSpec(found.dir, realDir, doc.spec);
    if (spec.ok) {
      specFile = spec.file;
      files.push({ file: `${entry.package}/${doc.spec}`, text: spec.text });
    } else at(['spec'], spec.message);
  }
  if (issues.length > 0) return { ok: false, issues };

  let code: LoadedPresetCode | undefined;
  if (aiops?.code !== undefined) {
    const loaded = await loadPresetCode({
      packageName: entry.package,
      dir: found.dir,
      code: aiops.code,
      ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
    });
    if (!loaded.ok) return loaded;
    code = loaded.code;
  }

  return {
    ok: true,
    preset: {
      id: entry.id,
      package: entry.package,
      version: found.version,
      adapter: doc.adapter,
      dir: found.dir,
      source,
      ...(specFile === undefined ? {} : { specFile }),
      ...(aiops === undefined ? {} : { sdk: aiops.sdk }),
      ...(doc.auth === undefined ? {} : { auth: doc.auth }),
      ...(doc.test === undefined ? {} : { test: doc.test }),
      operations: doc.operations,
      files,
      ...(code === undefined ? {} : { code }),
    },
  };
}

/** Reads the vendored spec of an openapi preset; it must lie inside the package, real path included. */
async function readPresetSpec(dir: string, realDir: string, path: string): Promise<{ ok: true; file: string; text: string } | { ok: false; message: string }> {
  const specFile = resolve(dir, path);
  if (isSpecUrl(path) || isAbsolute(path) || !isInside(dir, specFile)) return { ok: false, message: 'must be a path inside the preset' };
  // A symbolic link may still point elsewhere: compare the real paths too.
  let realSpec: string;
  try {
    realSpec = await realpath(specFile);
  } catch {
    return { ok: false, message: 'spec file cannot be read' };
  }
  if (!isInside(realDir, realSpec)) return { ok: false, message: 'must be a path inside the preset' };
  const spec = await readSpecFile(realSpec);
  return spec.ok ? { ok: true, file: realSpec, text: spec.text } : spec;
}

/** True when `path` is `dir` or below it (a first segment `..` leaves it; `..spec.json` does not). */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}
