// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AuditEventInput, ConfigListener, NewConfigRevision } from '@mandate/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { createDb, type Database } from '../../src/client.js';
import { CONFIG_CHANNEL, PostgresConfigRevisionStore } from '../../src/config-revision-store.js';
import { runMigrations } from '../../src/migrate.js';

const BACKOFF = { initialMs: 50, maxMs: 200 } as const;
const SUMMARY = { connections: 1, operations: 2, roles: 3, notifications: 0 } as const;
const LISTENER_ROWS =
  "SELECT pid FROM pg_stat_activity WHERE application_name = 'mandate-config-listener' AND datname = current_database()";

let postgres: StartedPostgres;
const databases: Database[] = [];
const listeners: ConfigListener[] = [];
const clients: pg.Client[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
  for (const client of clients.splice(0)) await client.end();
  for (const database of databases.splice(0)) await database.close();
  await postgres.stop();
});

interface Recorded {
  changes: number;
  reconnects: number;
  errors: string[];
}

/** A fresh migrated database, one pool for writes and the store under test on it. */
async function setup(): Promise<{ url: string; database: Database; store: PostgresConfigRevisionStore }> {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  const database = createDb(url, { onError: () => undefined });
  databases.push(database);
  return { url, database, store: new PostgresConfigRevisionStore(database.db, { databaseUrl: url, backoff: BACKOFF }) };
}

async function listen(store: PostgresConfigRevisionStore): Promise<{ recorded: Recorded; listener: ConfigListener }> {
  const recorded: Recorded = { changes: 0, reconnects: 0, errors: [] };
  const listener = await store.listen({
    onChange: () => { recorded.changes += 1; },
    onReconnect: () => { recorded.reconnects += 1; },
    onError: (message) => { recorded.errors.push(message); },
  });
  listeners.push(listener);
  return { recorded, listener };
}

/** An apply through its own store on its own pool: the listener's client is never the writer. */
function otherStore(url: string): PostgresConfigRevisionStore {
  const database = createDb(url, { onError: () => undefined });
  databases.push(database);
  return new PostgresConfigRevisionStore(database.db, { databaseUrl: url });
}

function revision(hash: string): NewConfigRevision {
  return { id: randomUUID(), hash, files: { 'config.yaml': `hash: ${hash}\n` }, actor: 'cli:alice', summary: SUMMARY };
}

function applyEvent(id: string = randomUUID()): AuditEventInput {
  return { id, actor: 'cli:alice', action: 'config.apply', outcome: 'ok', correlationId: randomUUID(), details: { note: 'listen' } };
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function listenerPids(database: Database): Promise<number[]> {
  const result = await database.pool.query<{ pid: number }>(LISTENER_ROWS);
  return result.rows.map((row) => row.pid);
}

const HASH = (c: string): string => c.repeat(64);

describe('CFG-3 PostgresConfigRevisionStore.listen', () => {
  it('CFG-3 NFR-3 an apply on another pool reaches the listener once, after commit', async () => {
    const { url, database, store } = await setup();
    const { recorded } = await listen(store);
    // A raw listener reads the payload, which onChange does not carry: the new seq as text.
    const raw = new pg.Client({ connectionString: url });
    clients.push(raw);
    await raw.connect();
    const payloads: string[] = [];
    raw.on('notification', (message) => { if (message.channel === CONFIG_CHANNEL) payloads.push(message.payload ?? ''); });
    await raw.query(`LISTEN ${CONFIG_CHANNEL}`);

    const writer = otherStore(url);
    const first = await writer.apply(revision(HASH('a')), applyEvent(), null);
    if (!first.ok) throw new Error(`apply refused: ${first.reason}`);
    await waitFor(() => recorded.changes === 1 && payloads.length === 1);
    expect(payloads).toEqual([String(first.revision.seq)]);

    // A rolled-back apply (its audit id already exists) notifies nobody. The next successful
    // apply is the barrier: notifications arrive in commit order.
    const [existing] = (await database.pool.query<{ id: string }>('SELECT id FROM audit_event')).rows;
    if (existing === undefined) throw new Error('no audit row');
    await expect(writer.apply(revision(HASH('b')), applyEvent(existing.id), HASH('a'))).rejects.toThrow(/^config apply failed/);
    const second = await writer.apply(revision(HASH('c')), applyEvent(), HASH('a'));
    if (!second.ok) throw new Error(`apply refused: ${second.reason}`);
    await waitFor(() => recorded.changes >= 2 && payloads.length >= 2);
    expect(recorded.changes).toBe(2);
    expect(payloads).toEqual([String(first.revision.seq), String(second.revision.seq)]);
    expect(recorded.errors).toEqual([]);
    expect(recorded.reconnects).toBe(0);
  });

  it('CFG-3 the listener reconnects after its backend is terminated and reports onReconnect', async () => {
    const { url, database, store } = await setup();
    const { recorded } = await listen(store);
    const [before] = await listenerPids(database);
    if (before === undefined) throw new Error('no listener backend');

    await database.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'mandate-config-listener' AND datname = current_database()",
    );
    await waitFor(() => recorded.errors.length >= 1 && recorded.reconnects >= 1);
    const after = await listenerPids(database);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(before);

    const writer = otherStore(url);
    const result = await writer.apply(revision(HASH('a')), applyEvent(), null);
    expect(result.ok).toBe(true);
    await waitFor(() => recorded.changes >= 1);
    // error and end both fire on a terminated backend: one onError, one reconnect.
    expect(recorded.errors).toEqual(['configuration listener connection failed']);
    expect(recorded.reconnects).toBe(1);
    expect(recorded.changes).toBe(1);
  });

  it('CFG-3 close stops reconnecting', async () => {
    const { url, database, store } = await setup();
    const closed = await listen(store);
    await closed.listener.close();
    await database.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'mandate-config-listener' AND datname = current_database()",
    );
    let empty = 0;
    await waitFor(async () => {
      empty = (await listenerPids(database)).length === 0 ? empty + 1 : 0;
      return empty >= 3;
    });

    // Barrier: a second, open listener hears an apply; the closed one heard nothing.
    const open = await listen(store);
    const result = await otherStore(url).apply(revision(HASH('a')), applyEvent(), null);
    expect(result.ok).toBe(true);
    await waitFor(() => open.recorded.changes === 1);
    expect(closed.recorded).toEqual({ changes: 0, reconnects: 0, errors: [] });
    expect(await listenerPids(database)).toHaveLength(1);
  });

  it('CFG-3 listen rejects with a fixed message when the first connect fails', async () => {
    const { database } = await setup();
    // Port 1 refuses connections; the URL (and its password) must not appear in the error.
    const unreachable = 'postgresql://user:secret-password@127.0.0.1:1/none';
    const store = new PostgresConfigRevisionStore(database.db, { databaseUrl: unreachable, backoff: BACKOFF });
    const handlers = { onChange: () => undefined, onReconnect: () => undefined, onError: () => undefined };
    const error = await store.listen(handlers).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('configuration listener connection failed');
    expect(String((error as Error).stack)).not.toContain('secret-password');
  });
});
