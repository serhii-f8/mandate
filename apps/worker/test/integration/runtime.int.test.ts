// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapters } from '@aiops/adapters';
import { parseWorkerEnv } from '@aiops/config';
import { mcpToolHash } from '@aiops/connector-sdk';
import { createDb, insertNotifications, parseMasterKeys, PostgresChangeSetRepository, PostgresCredentialVault, runMigrations } from '@aiops/db';
import { startFakeMcpServer, startPostgres, startSmtpSink, type StartedPostgres } from '@aiops/testing';
import { connectionCredential } from '@aiops/upstream';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startRuntimeConfiguration, startWorkerRuntime } from '../../src/runtime.js';
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
      // An ephemeral port: integration files run in parallel (ruling F11).
      AIOPS_WORKER_HTTP_PORT: '0',
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
      // An ephemeral port: integration files run in parallel (ruling F11).
      AIOPS_WORKER_HTTP_PORT: '0',
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
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    await expect(startWorkerRuntime(env, logger, signals)).rejects.toThrow(/ConnectionRefused/);
    expect(installedAtCleanup).toBe(1);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
    // NFR-10 F10: the HTTP server was listening during the start and is closed by its cleanup.
    const listening = lines
      .map((l) => JSON.parse(l) as { msg?: string; port?: number })
      .find((l) => l.msg === 'worker http server listening');
    expect(listening?.port).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${String(listening?.port)}/healthz`)).rejects.toThrow();
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
        AIOPS_WORKER_HTTP_PORT: '0',
      });
      await expect(startWorkerRuntime(env, logger, new EventEmitter())).rejects.toThrow(/ConnectionRefused/);
      const warnings = lines.map((l) => JSON.parse(l) as { msg?: string }).map((l) => l.msg);
      expect(warnings).toContain('AIOPS_SMTP_URL is not set: email notifications fail with channel_unconfigured');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  }, 60_000);
});

const MCP_MASTER_KEYS = '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=';
const MCP_TOKEN = 'int-only-mcp-bearer-value-0123456789';
const LOOKUP_TOOL = { name: 'lookup', description: 'Look up a record by key.', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } };

/** One mcp connection with a bearer credential and one pinned read; the URL and pin are filled in. */
const mcpConfig = (url: string, pin: string): string => `version: 1
connections:
  - id: tools
    adapter: mcp
    mcp_url: ${url}
    allow_private_network: true
    credential_ref: tools-token
    auth: { scheme: bearer }
    retry: { max_attempts: 1 }
operations:
  - id: tools.lookup
    connection: tools
    risk: read
    description: Look up a record by key.
    upstream: { tool: lookup, pin: ${pin} }
roles:
  - id: reader
    grants: [{ operation: tools.lookup }]
`;

describe('CONN-1 worker runtime with an mcp connection', () => {
  it('CONN-1 the worker loads a configuration with an mcp connection and lists its tools at load', async () => {
    const fake = await startFakeMcpServer({ tools: [LOOKUP_TOOL], mode: 'stateless' });
    const configDir = await mkdtemp(join(tmpdir(), 'aiops-worker-mcp-'));
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const database = createDb(url, { onError: () => undefined });
    try {
      await writeFile(join(configDir, 'aiops.yaml'), mcpConfig(fake.url, mcpToolHash(LOOKUP_TOOL)));
      const vault = new PostgresCredentialVault(database.db, parseMasterKeys(MCP_MASTER_KEYS));
      await vault.put({ ref: 'tools-token', scheme: 'bearer', secret: { token: MCP_TOKEN }, actor: 'int' });
      const env = parseWorkerEnv({
        DATABASE_URL: url,
        // Nothing listens here: the start fails at the connect, after the configuration was loaded and checked.
        TEMPORAL_ADDRESS: '127.0.0.1:1',
        AIOPS_CONFIG_DIR: configDir,
        AIOPS_MASTER_KEYS: MCP_MASTER_KEYS,
        AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
        AIOPS_WORKER_HTTP_PORT: '0',
      });
      // Ruling F10: the holder is only reachable through startRuntimeConfiguration; the adapter reads the vault as the runtime's does (R10).
      const adapter = createAdapters({
        credentialFor: async (ref) => {
          const credential = await connectionCredential(vault, ref);
          return credential === 'unusable' ? undefined : credential;
        },
      });
      const { holder, sync } = await startRuntimeConfiguration({ env, database, adapter, logger: pino({ level: 'silent' }), signals: new EventEmitter() });
      try {
        const catalog = holder.current.mcpCatalogs.get('tools');
        expect(catalog?.status).toBe('listed');
        expect(catalog?.status === 'listed' ? catalog.tools.map((t) => t.name) : []).toEqual(['lookup']);
      } finally {
        await sync.close();
      }
      // The runtime's own adapter lists with the stored credential (R10) and passes the full-check gate.
      const before = fake.requests.length;
      await expect(startWorkerRuntime(env, pino({ level: 'silent' }), new EventEmitter())).rejects.toThrow(/ConnectionRefused/);
      const listed = fake.requests.slice(before).filter((r) => r.rpcMethod === 'tools/list');
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((r) => r.headers.authorization === `Bearer ${MCP_TOKEN}`)).toBe(true);
    } finally {
      await database.close();
      await rm(configDir, { recursive: true, force: true });
      await fake.close();
    }
  }, 60_000);
});

// Last in this file: the SIGTERM that ends `run()` also shuts the process-wide Temporal runtime down,
// so both cases share one running worker and the SIGTERM comes in afterAll.
describe('NTF-1 NFR-10 NFR-12 a running worker runtime', () => {
  // Each is undefined until its step in beforeAll succeeds, so afterAll cleans up only what exists
  // and a failed beforeAll reports its own error.
  let temporal: TestWorkflowEnvironment | undefined;
  let sink: Awaited<ReturnType<typeof startSmtpSink>> | undefined;
  let configDir: string | undefined;
  let database: ReturnType<typeof createDb> | undefined;
  let runtime: Awaited<ReturnType<typeof startWorkerRuntime>> | undefined;
  let running: Promise<void> | undefined;

  function started(): { database: ReturnType<typeof createDb>; sink: Awaited<ReturnType<typeof startSmtpSink>>; runtime: Awaited<ReturnType<typeof startWorkerRuntime>> } {
    if (database === undefined || sink === undefined || runtime === undefined) throw new Error('the fixture did not start');
    return { database, sink, runtime };
  }

  beforeAll(async () => {
    const env0 = await TestWorkflowEnvironment.createLocal();
    temporal = env0;
    const smtp = await startSmtpSink();
    sink = smtp;
    const dir = await mkdtemp(join(tmpdir(), 'aiops-worker-notify-'));
    configDir = dir;
    const url = await postgres.createDatabase();
    await runMigrations(url);
    database = createDb(url, { onError: () => undefined });
    await writeFile(join(dir, 'aiops.yaml'), NOTIFYING_CONFIG);
    const env = parseWorkerEnv({
      DATABASE_URL: url,
      TEMPORAL_ADDRESS: env0.address,
      TEMPORAL_TASK_QUEUE: `notify-${randomUUID()}`,
      AIOPS_CONFIG_DIR: dir,
      AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
      AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
      AIOPS_SMTP_URL: smtp.url,
      AIOPS_WORKER_HTTP_PORT: '0',
    });
    const rt = await startWorkerRuntime(env, pino({ level: 'silent' }), new EventEmitter());
    runtime = rt;
    running = rt.run();
  }, 120_000);

  afterAll(async () => {
    try {
      // Worker.run() resolves after a graceful shutdown on SIGTERM; nothing else in this process listens.
      if (running !== undefined) process.emit('SIGTERM');
      await running;
      await runtime?.close();
    } finally {
      await database?.close();
      if (configDir !== undefined) await rm(configDir, { recursive: true, force: true });
      await sink?.close();
      await temporal?.teardown();
    }
  }, 120_000);

  it('NTF-1 the worker runtime dispatches a queued notification', async () => {
    const { database, sink } = started();
    const cs = await createPrepared(new PostgresChangeSetRepository(database.db), 1);
    await insertNotifications(database.db, cs.id, [{ kind: 'execution_finished', round: 0, step: 0, target: 'ops-mail' }], new Date());
    await vi.waitFor(
      () => {
        expect(sink.messages).toHaveLength(1);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(sink.messages[0]?.to).toEqual(['ops@example.test']);
  }, 60_000);

  it('NFR-10 NFR-12 the running worker is ready and serves its metrics', async () => {
    const { database, runtime } = started();
    await createPrepared(new PostgresChangeSetRepository(database.db), 1);
    const base = `http://127.0.0.1:${String(runtime.httpPort)}`;
    const report = await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/readyz`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        return (await res.json()) as { temporal: string; database: string; configuration: { hash: string } };
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(report.temporal).toBe('ok');
    expect(report.database).toBe('ok');
    const state = runtime.configuration.state();
    expect(state.status).toBe('active');
    expect(report.configuration.hash).toBe(state.status === 'active' ? state.hash : undefined);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/^aiops_changesets\{status="prepared"\} [1-9]/m);
  }, 60_000);
});
