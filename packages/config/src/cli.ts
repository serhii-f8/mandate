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

const USAGE = 'usage: aiops-config validate <dir>';

export async function runCli(argv: readonly string[], out: (line: string) => void): Promise<number> {
  const [command, dir, ...rest] = argv;
  if (command !== 'validate' || dir === undefined || rest.length > 0) {
    out(USAGE);
    return 2;
  }
  const result = await loadConfigurationDirectory(dir);
  if (!result.ok) {
    for (const issue of result.issues) out(formatIssue(issue));
    out(`Configuration invalid: ${String(result.issues.length)} issue${result.issues.length === 1 ? '' : 's'}`);
    return 1;
  }
  const { policy, connections } = result.configuration;
  out(
    `Configuration valid: ${String(connections.length)} connections, ${String(policy.operations.length)} operations, ${String(policy.roles.length)} roles`,
  );
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
