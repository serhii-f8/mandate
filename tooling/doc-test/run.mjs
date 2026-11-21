#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Doc-test runner (NFR-9): runs the marked blocks of docs/guide/ per section in bash.
// Usage: node tooling/doc-test/run.mjs <repo-dir> <section>...
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extract } from './extract.mjs';

export const SECTIONS = ['install', 'attach', 'role', 'bulk', 'backup'];
// Only the pages that carry doc-test sections are read, in reading order; markers on other pages are not scanned.
export const PAGES = [
  'installation.md',
  'connecting-magento.md',
  'roles-and-approvals.md',
  'first-bulk-update.md',
  'backup-and-restore.md',
];
const SECRET_NAME = '(TOKEN|SECRET|PASSWORD|COOKIE)';
const FAIL = '@@doc-test-fail';

// The export wrapper records every exported variable in $DOC_TEST_ENV; plain assignments do not persist.
const PRELUDE = `
. "$DOC_TEST_ENV"
export() {
  builtin export "$@"
  local a n
  for a in "$@"; do
    case "$a" in -*) continue ;; esac
    n="\${a%%=*}"
    printf 'export %s=%q\\n' "$n" "\${!n-}" >> "$DOC_TEST_ENV"
  done
}
__dt_secrets() {
  local v
  for v in $(compgen -v | grep -Ei '${SECRET_NAME}' || true); do printf '%s\\0' "\${!v-}"; done > "$DOC_TEST_SECRETS"
}
trap '__dt_secrets' EXIT
trap 'rc=$?; echo "${FAIL} $__B $rc" >&2; exit $rc' ERR
`;

/** @param {string} text @param {string[]} secrets @returns {string} */
function mask(text, secrets) {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('***');
  return out;
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const [repoArg, ...wanted] = argv;
  if (!repoArg || wanted.length === 0 || wanted.some((s) => !SECTIONS.includes(s))) {
    process.stderr.write(`usage: run.mjs <repo-dir> <${SECTIONS.join('|')}>...\n`);
    return 2;
  }
  const repo = resolve(repoArg);
  const pages = PAGES.map((p) => {
    const path = `docs/guide/${p}`;
    try {
      return { path, text: readFileSync(join(repo, path), 'utf8') };
    } catch {
      throw new Error(`missing guide page ${path}`);
    }
  });
  const blocks = extract(pages, SECTIONS);
  const dir = mkdtempSync(join(tmpdir(), 'doc-test-'));
  const envFile = join(dir, 'env');
  const secretsFile = join(dir, 'secrets');
  writeFileSync(envFile, '', { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const log = join(repo, '.doc-test.log');
  writeFileSync(log, '');
  let failed = false;
  try {
    for (const section of wanted) {
      if (failed) {
        console.log(`skip ${section}`);
        continue;
      }
      const list = blocks.get(section) ?? [];
      let script = PRELUDE;
      for (const b of list) script += `\n# block ${String(b.index)} (${b.path})\n__B=${String(b.index)}\n${b.code}`;
      writeFileSync(secretsFile, '');
      const r = spawnSync('bash', ['-eEuo', 'pipefail', '-c', script], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, DOC_TEST_ENV: envFile, DOC_TEST_SECRETS: secretsFile },
        maxBuffer: 256 * 1024 * 1024,
      });
      const secrets = readFileSync(secretsFile, 'utf8').split('\0');
      const output = `${r.stdout}${r.stderr}`;
      appendFileSync(log, mask(`== ${section} ==\n${output}\n`, secrets));
      const m = /@@doc-test-fail (\d+) (\d+)/.exec(r.stderr);
      if (r.status === 0) {
        console.log(`pass ${section}`);
      } else {
        failed = true;
        const n = Number(m?.[1] ?? 0);
        const code = m?.[2] ?? String(r.status ?? 1);
        const first = (list.find((b) => b.index === n)?.code ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
        console.log(mask(`fail ${section} block ${String(n)} exit ${code}: ${first}`, secrets));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
