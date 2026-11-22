// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preset resolution (CONN-8; design part 1 §3.4, ADR 0017; Phase 9 packages): a preset is a
 * package directory in one of the preset directories, chosen by its `package.json` name and
 * a semver range, holding a preset file (`mandate.preset`, default `preset.yaml`) and, for an
 * openapi preset, a vendored spec. Issues inside the preset are reported with the file
 * `<package>/<preset file>` (CFG-2), issues about `mandate` with `<package>/package.json`.
 * Parameters (ADR 0067): `{ $param: <name> }` nodes in `operations` and `test` are replaced by
 * the declared defaults before `presetDocumentSchema` applies, and again per binding with the
 * connection's `preset_params` (`bindPresetParams`).
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CONNECTOR_SDK_VERSION } from '@mandate/connector-sdk';
import semver from 'semver';
import { z } from 'zod';
import { pathToString, type ConfigIssue } from './issues.js';
import { loadPresetCode, type ImportModule, type LoadedPresetCode } from './preset-code.js';
import { parseMandateField, selectPackage } from './preset-package.js';
import { isParamNode, PRESET_PARAM_NAME, presetParamsSchema, resolveParamValues, substituteParams, type ParamIssue, type PresetParamDecl, type PresetParamValue } from './preset-params.js';
import { OPERATION_ID, PARSE_PARAMS, presetOperationSchema, schemaIssues, type PresetConfig, type PresetOperationConfig } from './schema.js';
import { findSecretKeys, SECRET_MESSAGE } from './secrets.js';
import { authSchema, connectionTestSchema, isSpecUrl, type AuthConfig, type ConnectionTestConfig } from './upstream-schema.js';
import { parseYamlSource, type SourceDocument } from './yaml-source.js';

/**
 * The preset file after its `{ $param: <name> }` nodes were replaced (ADR 0067): such a node may
 * stand anywhere inside `operations` and `test` of the file and is resolved before this schema.
 */
export const presetDocumentSchema = z.strictObject({
  version: z.literal(1),
  /** CONN-8: parameters with their defaults, set per binding by the connection's `preset_params`. */
  params: presetParamsSchema.optional(),
  /** The connection adapter the preset is for (CONN-8). */
  adapter: z.enum(['openapi', 'mcp']).default('openapi'),
  /** The vendored spec, relative to the preset directory: required for openapi, refused for mcp. */
  spec: z.string().min(1).max(1024).optional(),
  /** Default auth for connections that bind the preset without their own. */
  auth: authSchema.optional(),
  test: connectionTestSchema.optional(),
  operations: z.array(presetOperationSchema).default([]),
}).describe('A preset file after substitution: every mapping { $param: <name> } inside operations and test is replaced by the parameter value before this schema applies (CONN-8, ADR 0067).');

export interface LoadedPreset {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  /** The connection adapter the preset is for. */
  readonly adapter: 'openapi' | 'mcp';
  /** Absolute directory of the preset package. */
  readonly dir: string;
  /** The preset file (`mandate.preset`, default `preset.yaml`), named `<package>/<path>` in issues. */
  readonly source: SourceDocument;
  /** Absolute path of the vendored spec; an mcp preset has none. */
  readonly specFile?: string;
  /** `mandate.sdk` of the package; absent for a package without `mandate`. */
  readonly sdk?: string;
  readonly auth?: AuthConfig;
  readonly test?: ConnectionTestConfig;
  /** The operations with the parameter defaults substituted (ADR 0067). */
  readonly operations: readonly PresetOperationConfig[];
  /** CONN-8: the declared parameters; empty when the preset declares none. */
  readonly params: Readonly<Record<string, PresetParamDecl>>;
  /** The `operations` of the preset file before substitution; each binding substitutes its own copy. */
  readonly rawOperations: readonly unknown[];
  /** The `test` of the preset file before substitution, when it has one. */
  readonly rawTest?: unknown;
  /** `package.json`, the preset file and the spec (openapi only), in this order; covered by the configuration hash. */
  readonly files: readonly { readonly file: string; readonly text: string }[];
  /** The code module of `mandate.code` (OPS-5); its tree digest is covered by the configuration hash (CFG-4). */
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

  // The `mandate` field (CONN-8, NFR-18); issues name `<package>/package.json`.
  const packageFile = `${entry.package}/package.json`;
  const packageIssue = (key: string, message: string): PresetResult => ({ ok: false, issues: [{ file: packageFile, path: `mandate.${key}`, message }] });
  const mandateField = parseMandateField(JSON.parse(found.packageJson));
  if (!mandateField.ok) return { ok: false, issues: mandateField.issues.map((issue) => ({ file: packageFile, path: pathToString(issue.path), message: issue.message })) };
  const mandate = mandateField.mandate;
  if (mandate !== undefined && !semver.satisfies(CONNECTOR_SDK_VERSION, mandate.sdk)) {
    return packageIssue('sdk', `preset_sdk_incompatible: the preset requires connector SDK ${mandate.sdk}; this platform provides ${CONNECTOR_SDK_VERSION}`);
  }

  const realDir = await realpath(found.dir);
  const presetPath = mandate?.preset ?? 'preset.yaml';
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
  // CONN-8: parameters first, so their defaults stand in for the `{ $param }` nodes below.
  const raw = isRecord(source.value) ? source.value : undefined;
  const bound = raw === undefined ? undefined : bindDefaults(raw, at);
  if (issues.length > 0) return { ok: false, issues };
  const result = presetDocumentSchema.safeParse(bound ?? source.value ?? {}, PARSE_PARAMS);
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
  if (mandate?.code !== undefined) {
    const loaded = await loadPresetCode({
      packageName: entry.package,
      dir: found.dir,
      code: mandate.code,
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
      ...(mandate === undefined ? {} : { sdk: mandate.sdk }),
      ...(doc.auth === undefined ? {} : { auth: doc.auth }),
      ...(doc.test === undefined ? {} : { test: doc.test }),
      operations: doc.operations,
      params: doc.params ?? {},
      rawOperations: Array.isArray(raw?.operations) ? raw.operations : [],
      ...(raw?.test === undefined ? {} : { rawTest: raw.test }),
      files,
      ...(code === undefined ? {} : { code }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The keys of a preset file that may hold `{ $param }` nodes. */
const PARAMETERIZED = ['operations', 'test'] as const;

/**
 * The preset document with the parameter defaults substituted into `operations` and `test`.
 * Invalid declarations and `$param` names that are not declared are reported through `at`.
 */
function bindDefaults(raw: Record<string, unknown>, at: (path: readonly PropertyKey[], message: string) => void): Record<string, unknown> | undefined {
  const declared = presetParamsSchema.safeParse(raw.params ?? {}, PARSE_PARAMS);
  for (const issue of schemaIssues(declared)) at(['params', ...issue.path], issue.message);
  if (!declared.success) return undefined;
  // The nodes that name an operation or its field list stay fixed: a binding cannot rename an
  // operation, retarget its test, or move the fields its policy and approval rules read.
  const fixed = (node: unknown, path: readonly PropertyKey[]): void => {
    if (isRecord(node) && isParamNode(node)) at(path, 'must not be a parameter');
  };
  if (Array.isArray(raw.operations)) {
    raw.operations.forEach((op: unknown, index) => {
      if (!isRecord(op)) return;
      fixed(op.id, ['operations', index, 'id']);
      fixed(op.fields_arg, ['operations', index, 'fields_arg']);
      if (isRecord(op.manifest)) {
        fixed(op.manifest.action, ['operations', index, 'manifest', 'action']);
        fixed(op.manifest.values_arg, ['operations', index, 'manifest', 'values_arg']);
        fixed(op.manifest.records_arg, ['operations', index, 'manifest', 'records_arg']);
        // A check code is a reason code approvers see and stats count (CS-3): one meaning per preset.
        if (Array.isArray(op.manifest.checks)) {
          op.manifest.checks.forEach((check: unknown, c) => {
            if (isRecord(check)) fixed(check.code, ['operations', index, 'manifest', 'checks', c, 'code']);
          });
        }
      }
    });
  }
  if (isRecord(raw.test)) fixed(raw.test.operation, ['test', 'operation']);
  const defaults = resolveParamValues(declared.data, undefined);
  // Defaults alone cannot fail; kept total for the type.
  if (!defaults.ok) return undefined;
  const bound: Record<string, unknown> = { ...raw };
  for (const key of PARAMETERIZED) {
    if (!Object.hasOwn(raw, key)) continue;
    const substituted = substituteParams(raw[key], defaults.values);
    if (substituted.ok) bound[key] = substituted.value;
    else at([key], `names undeclared preset parameters: ${substituted.unknown.map((name) => (PRESET_PARAM_NAME.test(name) ? name : '(invalid name)')).join(', ')}`);
  }
  return bound;
}

/** CONN-8: what one connection binds of a preset. */
export type PresetParamsBinding =
  | {
      readonly ok: true;
      readonly values: Readonly<Record<string, PresetParamValue>>;
      readonly operations: readonly PresetOperationConfig[];
      readonly test?: ConnectionTestConfig;
    }
  | { readonly ok: false; readonly issues: readonly ParamIssue[] };

const presetOperationsSchema = z.array(presetOperationSchema);

/**
 * CONN-8: the operations and test of `preset` for one binding. Without `given` they are the
 * default-bound ones; with it, the values are checked against the declarations, substituted into
 * a fresh copy of the raw nodes and validated again. Issue paths are relative to `preset_params`.
 */
export function bindPresetParams(preset: LoadedPreset, given: Readonly<Record<string, unknown>> | undefined): PresetParamsBinding {
  const resolved = resolveParamValues(preset.params, given);
  if (!resolved.ok) return resolved;
  const { values } = resolved;
  if (given === undefined) return { ok: true, values, operations: preset.operations, ...(preset.test === undefined ? {} : { test: preset.test }) };
  const issues: ParamIssue[] = [];
  // The raw nodes passed the default substitution at resolve time, so every name is declared;
  // the check stays so a binding never proceeds on a partial substitution.
  const operations = substituteParams(preset.rawOperations, values);
  const rawTest = preset.rawTest === undefined ? undefined : substituteParams(preset.rawTest, values);
  if (!operations.ok || rawTest?.ok === false) return { ok: false, issues: [{ path: [], message: 'the preset names undeclared parameters' }] };
  const parsedOps = presetOperationsSchema.safeParse(operations.value, PARSE_PARAMS);
  for (const { path: [index, ...rest], message } of schemaIssues(parsedOps)) {
    const op: unknown = typeof index === 'number' && Array.isArray(operations.value) ? operations.value[index] : undefined;
    const id = isRecord(op) && typeof op.id === 'string' && OPERATION_ID.test(op.id) ? op.id : `operations[${String(index)}]`;
    issues.push({ path: [], message: `makes preset operation ${id} invalid: ${withPath(rest, message)}` });
  }
  let test: ConnectionTestConfig | undefined;
  if (rawTest !== undefined) {
    const parsedTest = connectionTestSchema.safeParse(rawTest.value, PARSE_PARAMS);
    for (const { path, message } of schemaIssues(parsedTest)) issues.push({ path: [], message: `makes the preset test invalid: ${withPath(path, message)}` });
    if (parsedTest.success) test = parsedTest.data;
  }
  if (issues.length > 0 || !parsedOps.success) return { ok: false, issues };
  return { ok: true, values, operations: parsedOps.data, ...(test === undefined ? {} : { test }) };
}

/** `<path> <message>`, or the message alone at the root. */
export function withPath(path: readonly PropertyKey[], message: string): string {
  const where = pathToString(path);
  return where === '' ? message : `${where} ${message}`;
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
