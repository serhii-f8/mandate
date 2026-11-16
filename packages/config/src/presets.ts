/**
 * Preset resolution, first cut of CONN-8 (design part 1 §3.4, ADR 0017): a preset is a
 * package directory in one of the preset directories, found by its `package.json` name,
 * holding a `preset.yaml` and a vendored spec. Issues inside the preset are reported
 * with the file `<package>/preset.yaml` (CFG-2).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { pathToString, type ConfigIssue } from './issues.js';
import { presetOperationSchema, schemaIssues, type PresetConfig, type PresetOperationConfig } from './schema.js';
import { findSecretKeys, SECRET_MESSAGE } from './secrets.js';
import { authSchema, connectionTestSchema, isSpecUrl, type AuthConfig, type ConnectionTestConfig } from './upstream-schema.js';
import { parseYamlSource, type SourceDocument } from './yaml-source.js';

export const presetDocumentSchema = z.strictObject({
  version: z.literal(1),
  /** The vendored spec, relative to the preset directory. */
  spec: z.string().min(1).max(1024),
  /** Default auth for connections that bind the preset without their own. */
  auth: authSchema.optional(),
  test: connectionTestSchema.optional(),
  operations: z.array(presetOperationSchema).default([]),
});

export interface LoadedPreset {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  /** Absolute directory of the preset package. */
  readonly dir: string;
  /** `preset.yaml`, named `<package>/preset.yaml` in issues. */
  readonly source: SourceDocument;
  /** Absolute path of the vendored spec. */
  readonly specFile: string;
  readonly auth?: AuthConfig;
  readonly test?: ConnectionTestConfig;
  readonly operations: readonly PresetOperationConfig[];
  /** `package.json`, `preset.yaml` and the spec, in this order; covered by the configuration hash. */
  readonly files: readonly { readonly file: string; readonly text: string }[];
}

export type PresetResult = { ok: true; preset: LoadedPreset } | { ok: false; issues: ConfigIssue[] };

/** Where the `presets` entry is declared, so issues about it point there. */
export interface PresetEntryLocation {
  readonly source: SourceDocument;
  readonly path: readonly PropertyKey[];
}

const packageJsonSchema = z.object({ name: z.string(), version: z.string() });

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

export async function resolvePreset(entry: PresetConfig, dirs: readonly string[], declared?: PresetEntryLocation): Promise<PresetResult> {
  const entryIssue = (key: 'package' | 'version', message: string): ConfigIssue => {
    if (declared === undefined) return { file: '.', path: pathToString(['presets', entry.id, key]), message };
    const path = [...declared.path, key];
    return { file: declared.source.file, path: pathToString(path), ...(declared.source.locate(path) ?? {}), message };
  };

  const found = await findPackage(entry.package, dirs);
  if (found === undefined) return { ok: false, issues: [entryIssue('package', 'is not installed in the preset directories')] };
  if (entry.version !== undefined && found.version !== entry.version) {
    return { ok: false, issues: [entryIssue('version', 'does not match the installed package version')] };
  }

  const file = `${entry.package}/preset.yaml`;
  let text: string;
  try {
    text = await readFile(join(found.dir, 'preset.yaml'), 'utf8');
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
  const result = presetDocumentSchema.safeParse(source.value ?? {});
  for (const issue of schemaIssues(result)) at(issue.path, issue.message);
  if (!result.success || issues.length > 0) return { ok: false, issues };
  const doc = result.data;

  const specFile = resolve(found.dir, doc.spec);
  const inside = relative(found.dir, specFile);
  if (isSpecUrl(doc.spec) || isAbsolute(doc.spec) || inside.startsWith('..') || isAbsolute(inside)) {
    at(['spec'], 'must be a path inside the preset');
    return { ok: false, issues };
  }
  const spec = await readSpecFile(specFile);
  if (!spec.ok) {
    at(['spec'], spec.message);
    return { ok: false, issues };
  }

  return {
    ok: true,
    preset: {
      id: entry.id,
      package: entry.package,
      version: found.version,
      dir: found.dir,
      source,
      specFile,
      ...(doc.auth === undefined ? {} : { auth: doc.auth }),
      ...(doc.test === undefined ? {} : { test: doc.test }),
      operations: doc.operations,
      files: [
        { file: `${entry.package}/package.json`, text: found.packageJson },
        { file, text },
        { file: `${entry.package}/${doc.spec}`, text: spec.text },
      ],
    },
  };
}

/** The first package directory, in directory order, whose `package.json` has the name. */
async function findPackage(name: string, dirs: readonly string[]): Promise<{ dir: string; version: string; packageJson: string } | undefined> {
  for (const root of dirs) {
    for (const dir of await candidates(root)) {
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
      if (pkg.success && pkg.data.name === name) return { dir, version: pkg.data.version, packageJson: text };
    }
  }
  return undefined;
}

/** Package directories directly under `root`, and under its `@scope` directories. */
async function candidates(root: string): Promise<string[]> {
  const list = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return [];
    }
  };
  const out: string[] = [];
  for (const name of await list(root)) {
    if (name.startsWith('@')) for (const child of await list(join(root, name))) out.push(join(root, name, child));
    else out.push(join(root, name));
  }
  return out;
}
