import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseWorkerEnv } from '@aiops/config';
import { runMigrations } from '@aiops/db';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../../src/runtime.js';

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
    await expect(startWorkerRuntime(env, pino({ level: 'silent' }), signals)).rejects.toThrow(/ConnectionRefused/);
    expect(signals.listenerCount('SIGHUP')).toBe(1);
  }, 60_000);
});
