#!/usr/bin/env node
/**
 * `aiops-config` (CFG-3). Phase 2 ships `validate`; `diff`, `apply`,
 * `test-connection` and `explain` follow in Phases 3 and 8.
 * Exit codes: 0 valid, 1 invalid, 2 usage.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatIssue } from './issues.js';
import { loadConfigurationDirectory } from './load.js';

const USAGE = 'usage: aiops-config validate <dir> [--preset-dir <dir>]...';

/** Preset directories from `--preset-dir` (repeatable), else `AIOPS_PRESET_DIRS`; undefined when neither is set. */
function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): { dir: string; presetDirs?: string[] } | undefined {
  const [command, dir, ...rest] = argv;
  if (command !== 'validate' || dir === undefined || dir.startsWith('--')) return undefined;
  const flagged: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== '--preset-dir' || value === undefined || value === '') return undefined;
    flagged.push(value);
  }
  if (flagged.length > 0) return { dir, presetDirs: flagged };
  const fromEnv = env.AIOPS_PRESET_DIRS?.split(':').map((d) => d.trim()).filter((d) => d.length > 0);
  return fromEnv === undefined || fromEnv.length === 0 ? { dir } : { dir, presetDirs: fromEnv };
}

export async function runCli(
  argv: readonly string[],
  out: (line: string) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const args = parseArgs(argv, env);
  if (args === undefined) {
    out(USAGE);
    return 2;
  }
  // Without preset directories the presets are not loaded; the result says so.
  const result = await loadConfigurationDirectory(args.dir, args.presetDirs === undefined ? {} : { presetDirs: args.presetDirs });
  if (!result.ok) {
    for (const issue of result.issues) out(formatIssue(issue));
    out(`Configuration invalid: ${String(result.issues.length)} issue${result.issues.length === 1 ? '' : 's'}`);
    return 1;
  }
  const { policy, connections, specChecksSkipped, presetChecksSkipped } = result.configuration;
  out(
    `Configuration valid: ${String(connections.length)} connections, ${String(policy.operations.length)} operations, ${String(policy.roles.length)} roles`,
  );
  if (presetChecksSkipped) out('Preset checks skipped: set AIOPS_PRESET_DIRS or pass --preset-dir for the full check');
  // This CLI has no adapter (package boundaries); the api CLI resolves specs (ADR 0017).
  if (specChecksSkipped) out('Spec checks skipped: run "aiops validate" in the api for the full check');
  return 0;
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await runCli(process.argv.slice(2), (line) => {
    console.log(line);
  });
}
