// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// restore.sh refusal guards against a fake `docker` on PATH (NFR-13): a guard whose probe fails must
// stop the restore before anything is replaced, never read the failure as "empty".
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['mandate.dump', 'temporal.dump', 'temporal_visibility.dump', 'keycloak.dump', 'audit-archive.tar'];
const VERIFY = `ok sealed=3 unsealed=0 from=1 head=3:sha256:${'a'.repeat(64)}`;

// Answers by matching the docker arguments; every call is logged. FAKE_TABLE / FAKE_ROWS / FAKE_ARCHIVE
// are "fail" (exit 1, no output) or the text to print.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
answer() { if [ "$1" = fail ]; then exit 1; fi; printf '%s\\n' "$1"; exit 0; }
case "$*" in
  *"to_regclass"*) answer "$FAKE_TABLE" ;;
  *"EXISTS (SELECT 1 FROM public.audit_event)"*) answer "$FAKE_ROWS" ;;
  *"--entrypoint sh api -c"*"find"*"-print"*) answer "$FAKE_ARCHIVE" ;;
  *"--entrypoint sh api -c"*"ls -A"*) answer "$FAKE_ARCHIVE" ;;
  *"audit verify"*) printf '%s\\n' "${VERIFY}"; exit 0 ;;
  *) exit 0 ;;
esac
`;

function backupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'restore-guards-'));
  const entries = FILES.map((f) => {
    writeFileSync(join(dir, f), `content of ${f}\n`);
    const sha = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
    return `    "${f}": { "bytes": 1, "sha256": "${sha}" }`;
  });
  writeFileSync(
    join(dir, 'manifest.json'),
    `{\n  "created": "2026-11-21T00:00:00Z",\n  "files": {\n${entries.join(',\n')}\n  },\n  "auditHead": "3:sha256:${'a'.repeat(64)}",\n  "auditVerify": "${VERIFY}",\n  "images": {}\n}\n`,
  );
  return dir;
}

function restore(env: { table: string; rows: string; archive: string }): { status: number | null; stderr: string; calls: string } {
  const bin = mkdtempSync(join(tmpdir(), 'restore-docker-'));
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(root, 'deploy/backup/restore.sh'), backupDir()], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_LOG: log, FAKE_TABLE: env.table, FAKE_ROWS: env.rows, FAKE_ARCHIVE: env.archive },
  });
  return { status: r.status, stderr: r.stderr, calls: readFileSync(log, 'utf8') };
}

const EMPTY_ARCHIVE = 'empty';

describe('NFR-13 restore.sh refusal guards fail closed', () => {
  it('NFR-13 a failing probe of the mandate tables stops the restore before pg_restore', () => {
    const r = restore({ table: 'fail', rows: 'f', archive: EMPTY_ARCHIVE });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot inspect/);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 a failing probe of the audit rows stops the restore before pg_restore', () => {
    const r = restore({ table: 't', rows: 'fail', archive: EMPTY_ARCHIVE });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot inspect/);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 an unexpected probe answer stops the restore', () => {
    const r = restore({ table: 'maybe', rows: 'f', archive: EMPTY_ARCHIVE });
    expect(r.status).not.toBe(0);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 a failing probe of the audit archive stops the restore before pg_restore', () => {
    const r = restore({ table: 'f', rows: 'f', archive: 'fail' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot inspect/);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 a database with audit rows is refused without --force', () => {
    const r = restore({ table: 't', rows: 't', archive: EMPTY_ARCHIVE });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing: database not empty/);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 a non-empty audit archive is refused without --force', () => {
    const r = restore({ table: 'f', rows: 'f', archive: 'nonempty' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing: audit archive not empty/);
    expect(r.calls).not.toMatch(/pg_restore/);
  });

  it('NFR-13 an empty target passes both guards and is restored', () => {
    const r = restore({ table: 'f', rows: 'f', archive: EMPTY_ARCHIVE });
    expect(r.stderr).not.toMatch(/refusing|cannot inspect/);
    expect(r.calls).toMatch(/pg_restore/);
    expect(r.status).toBe(0);
  });
});
