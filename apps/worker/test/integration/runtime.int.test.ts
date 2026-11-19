import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkerEnv } from '@aiops/config';
import { createDb, insertNotifications, PostgresChangeSetRepository, runMigrations } from '@aiops/db';
import { startPostgres, startSmtpSink, type StartedPostgres } from '@aiops/testing';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startWorkerRuntime } from '../../src/runtime.js';
import { createPrepared } from '../support/changesets.js';

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

describe('NFR-4 worker runtime start-up', () => {
  it('NFR-4 the worker refuses to start against an unmigrated database', async () => {
    const env = parseWorkerEnv({
      DATABASE_URL: await postgres.createDatabase(),
      // Nothing listens here: reaching Temporal (or the configuration) would fail differently.
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      AIOPS_CONFIG_DIR: '/nonexistent/aiops-config',
      AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
      AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
    });
    await expect(startWorkerRuntime(env, pino({ level: 'silent' }))).rejects.toThrow(/not migrated/);
  });

  it('NFR-4 CFG-2 the SIGHUP handler is installed before the Temporal connect, so an early SIGHUP never ends the process', async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const env = parseWorkerEnv({
      DATABASE_URL: url,
      // Nothing listens here: the connect fails after the configuration was loaded.
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      AIOPS_CONFIG_DIR: fileURLToPath(new URL('../../../../deploy/config', import.meta.url)),
      AIOPS_PRESET_DIRS: fileURLToPath(new URL('../../../../presets', import.meta.url)),
      AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
      AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
    });
    const signals = new EventEmitter();
    // The start-failure cleanup removes the handler again (F6), so the count is taken when it does:
    // the connect failed with the handler in place.
    let installedAtCleanup: number | undefined;
    const off = signals.off.bind(signals);
    signals.off = (event, listener) => {
      if (event === 'SIGHUP') installedAtCleanup = signals.listenerCount('SIGHUP');
      return off(event, listener);
    };
    await expect(startWorkerRuntime(env, pino({ level: 'silent' }), signals)).rejects.toThrow(/ConnectionRefused/);
    expect(installedAtCleanup).toBe(1);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
    // The configuration came from a revision bootstrapped from deploy/config (CFG-4).
    const database = createDb(url, { onError: () => undefined });
    try {
      const { rows } = await database.pool.query<{ count: string }>('select count(*) from config_revision');
      expect(rows[0]?.count).toBe('1');
    } finally {
      await database.close();
    }
  }, 60_000);
});

/** Only an e-mail notification and the role whose results it receives; no connection is needed to dispatch. */
const NOTIFYING_CONFIG = `version: 1
notifications:
  - { id: ops-mail, kind: email, to: [ops@example.test] }
roles:
  - id: editor
    grants: []
    notify: { results: [ops-mail] }
`;

describe('NTF-3 worker runtime without a mail relay', () => {
  it('NTF-3 the worker warns at start when e-mail notifications are configured without AIOPS_SMTP_URL', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'aiops-worker-nosmtp-'));
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => lines.push(line) });
    try {
      await writeFile(join(configDir, 'aiops.yaml'), NOTIFYING_CONFIG);
      const env = parseWorkerEnv({
        DATABASE_URL: url,
        // Nothing listens here: the start fails after the warning.
        TEMPORAL_ADDRESS: '127.0.0.1:1',
        AIOPS_CONFIG_DIR: configDir,
        AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
        AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
      });
      await expect(startWorkerRuntime(env, logger, new EventEmitter())).rejects.toThrow(/ConnectionRefused/);
      const warnings = lines.map((l) => JSON.parse(l) as { msg?: string }).map((l) => l.msg);
      expect(warnings).toContain('AIOPS_SMTP_URL is not set: email notifications fail with channel_unconfigured');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Last in this file: the SIGTERM that ends `run()` also shuts the process-wide Temporal runtime down.
describe('NTF-1 worker runtime notifications', () => {
  it('NTF-1 the worker runtime dispatches a queued notification', async () => {
    const temporal = await TestWorkflowEnvironment.createLocal();
    const sink = await startSmtpSink();
    const configDir = await mkdtemp(join(tmpdir(), 'aiops-worker-notify-'));
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const database = createDb(url, { onError: () => undefined });
    try {
      await writeFile(join(configDir, 'aiops.yaml'), NOTIFYING_CONFIG);
      const env = parseWorkerEnv({
        DATABASE_URL: url,
        TEMPORAL_ADDRESS: temporal.address,
        TEMPORAL_TASK_QUEUE: `notify-${randomUUID()}`,
        AIOPS_CONFIG_DIR: configDir,
        AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
        AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
        AIOPS_SMTP_URL: sink.url,
      });
      const runtime = await startWorkerRuntime(env, pino({ level: 'silent' }), new EventEmitter());
      const running = runtime.run();
      try {
        const cs = await createPrepared(new PostgresChangeSetRepository(database.db), 1);
        await insertNotifications(database.db, cs.id, [{ kind: 'execution_finished', round: 0, step: 0, target: 'ops-mail' }], new Date());
        await vi.waitFor(
          () => {
            expect(sink.messages).toHaveLength(1);
          },
          { timeout: 15_000, interval: 100 },
        );
        expect(sink.messages[0]?.to).toEqual(['ops@example.test']);
      } finally {
        // Worker.run() resolves after a graceful shutdown on SIGTERM; nothing else in this process listens.
        process.emit('SIGTERM');
        await running;
        await runtime.close();
      }
    } finally {
      await database.close();
      await rm(configDir, { recursive: true, force: true });
      await sink.close();
      await temporal.teardown();
    }
  }, 120_000);
});
