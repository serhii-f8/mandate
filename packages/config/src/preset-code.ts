/**
 * Preset code modules (OPS-5, CONN-8, CFG-4; Phase 9 presets design): the ES module named by
 * `aiops.code`, the directory tree it lives in, and the digest of that tree, which is part of
 * the configuration hash. The module is imported once per tree digest; a changed tree under an
 * entry this process already imported is refused until restart, because Node caches the
 * module's relative imports by URL and would run stale code.
 *
 * Every issue names `<package>/package.json` at `aiops.code` and never a path or an error
 * message of the module: import failures report only the error's `ERR_*` code.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePresetModule, type PresetModule } from '@aiops/connector-sdk';
import type { ConfigIssue } from './issues.js';

export interface LoadedPresetCode {
  /** Real path of the entry module. */
  readonly entry: string;
  /** Hex SHA-256 of the code tree (CFG-4). */
  readonly digest: string;
  readonly module: PresetModule;
}

/** Imports a module URL; production uses native `import()`, tests may pass Node's own loader (F23). */
export type ImportModule = (url: string) => Promise<unknown>;

export interface PresetCodeInput {
  readonly packageName: string;
  /** The preset package directory. */
  readonly dir: string;
  /** `aiops.code`: a relative path to an ES module in a subdirectory of the package. */
  readonly code: string;
  readonly importModule?: ImportModule;
}

export type PresetCodeResult = { ok: true; code: LoadedPresetCode } | { ok: false; issues: ConfigIssue[] };

export const MAX_CODE_FILES = 2000;
export const MAX_CODE_BYTES = 20 * 1024 * 1024;

const ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/;

/** Real entry path to the tree digest it was imported with, for this process. */
const imported = new Map<string, string>();

/** Exposed for tests: forgets the process-wide import record. */
export function resetPresetCodeImports(): void {
  imported.clear();
}

const nativeImport: ImportModule = (url) => import(/* @vite-ignore */ url);

export async function loadPresetCode(input: PresetCodeInput): Promise<PresetCodeResult> {
  const fail = (message: string): PresetCodeResult => ({ ok: false, issues: [{ file: `${input.packageName}/package.json`, path: 'aiops.code', message }] });
  const placement = 'must be a path inside a subdirectory of the preset';

  // The logical path first: relative, inside the package, below its root.
  const entryPath = resolve(input.dir, input.code);
  if (isAbsolute(input.code) || !isBelow(input.dir, dirname(entryPath))) return fail(placement);

  // Then the real paths: a link may lead to the root or out of the package.
  let realDir: string;
  let realEntry: string;
  try {
    realDir = await realpath(input.dir);
    realEntry = await realpath(entryPath);
    if (!(await stat(realEntry)).isFile()) return fail('cannot be imported (ERR_MODULE_NOT_FOUND)');
  } catch {
    return fail('cannot be imported (ERR_MODULE_NOT_FOUND)');
  }
  const realCodeDir = dirname(realEntry);
  if (!isBelow(realDir, realCodeDir)) return fail(placement);

  const tree = await digestTree(realCodeDir, realDir);
  if (!tree.ok) return fail(tree.message);
  const { digest } = tree;

  const previous = imported.get(realEntry);
  if (previous !== undefined && previous !== digest) return fail('preset code changed since this process loaded it; restart the process');
  // Recorded before the import: a failed import may still have cached the module's relative imports.
  imported.set(realEntry, digest);

  let namespace: unknown;
  try {
    namespace = await (input.importModule ?? nativeImport)(`${pathToFileURL(realEntry).href}?aiops-code=${digest}`);
  } catch (error) {
    return fail(`cannot be imported (${errorCode(error)})`);
  }

  // A hostile module may throw from a getter of its namespace or default export (T1 M4).
  let parsed: ReturnType<typeof parsePresetModule>;
  try {
    const exported = typeof namespace === 'object' && namespace !== null ? (namespace as { readonly default?: unknown }).default : undefined;
    parsed = parsePresetModule(exported);
  } catch {
    return fail('default export is not a preset module: the export threw when it was read');
  }
  if (!parsed.ok) return fail(`default export is not a preset module: ${parsed.message}`);
  return { ok: true, code: { entry: realEntry, digest, module: parsed.module } };
}

/** The error's `code` when it is a Node `ERR_*` code, else `unknown`; never its message. */
function errorCode(error: unknown): string {
  try {
    const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

type TreeResult = { ok: true; digest: string } | { ok: false; message: string };

/**
 * Walks the code tree with `lstat`: every link must resolve inside the package's real
 * directory; linked directories are followed, a cycle counts as exceeding the limits. The
 * digest is the SHA-256 over the sorted POSIX relative paths, each followed by `\0`, the hex
 * SHA-256 of the file's bytes and `\0`.
 */
async function digestTree(root: string, realPackageDir: string): Promise<TreeResult> {
  const limits = 'code directory exceeds 2000 files or 20 MiB';
  const files: { rel: string; real: string }[] = [];
  let bytes = 0;

  type Step = { ok: true } | { ok: false; message: string };
  const walk = async (dir: string, rel: string, ancestors: readonly string[]): Promise<Step> => {
    const names = (await readdir(dir)).sort(byCodeUnit);
    for (const name of names) {
      const path = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      let info = await lstat(path);
      let real = path;
      if (info.isSymbolicLink()) {
        try {
          real = await realpath(path);
        } catch {
          return { ok: false, message: 'code directory links outside the preset' };
        }
        if (!isInsideOrAt(realPackageDir, real)) return { ok: false, message: 'code directory links outside the preset' };
        info = await stat(real);
      }
      if (info.isDirectory()) {
        if (ancestors.includes(real)) return { ok: false, message: limits };
        const step = await walk(real, relPath, [...ancestors, real]);
        if (!step.ok) return step;
      } else if (info.isFile()) {
        bytes += info.size;
        files.push({ rel: relPath, real });
        if (files.length > MAX_CODE_FILES || bytes > MAX_CODE_BYTES) return { ok: false, message: limits };
      }
      // Sockets, FIFOs and devices cannot be imported; they are not part of the tree.
    }
    return { ok: true };
  };

  try {
    const step = await walk(root, '', [root]);
    if (!step.ok) return step;
    const digest = createHash('sha256');
    for (const { rel, real } of files.sort((a, b) => byCodeUnit(a.rel, b.rel))) {
      const content: Buffer = await readFile(real);
      digest.update(rel).update('\0').update(createHash('sha256').update(content).digest('hex')).update('\0');
    }
    return { ok: true, digest: digest.digest('hex') };
  } catch {
    return { ok: false, message: 'code directory cannot be read' };
  }
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `path` is `dir` or below it. */
function isInsideOrAt(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** True when `path` is strictly below `dir`. */
function isBelow(dir: string, path: string): boolean {
  return isInsideOrAt(dir, path) && relative(dir, path) !== '';
}
