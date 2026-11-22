// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { PostgresSessionStore, type SessionRow } from '../../src/web-sessions.js';

let postgres: StartedPostgres;
let database: Database;
let second: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  database = createDb(url, { onError: () => undefined });
  second = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await database.close();
  await second.close();
  await postgres.stop();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM web_login');
  await database.pool.query('DELETE FROM web_session');
});

const NOW = new Date('2030-01-01T00:00:00Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const login = (expiresAt: Date) => ({
  stateHash: 'state-hash-1',
  codeVerifier: 'verifier',
  nonce: 'nonce',
  returnTo: '/connections',
  fresh: false,
  expiresAt,
});
const session = (expiresAt: Date): SessionRow => ({
  idHash: 'id-hash-1',
  subject: 'sub-1',
  username: 'alice',
  clientId: 'mandate-web',
  groups: ['admin', 'sales'],
  authTime: NOW,
  csrfToken: 'csrf',
  expiresAt,
});

describe('NFR-3 page sessions live in PostgreSQL', () => {
  it('consumes a login state exactly once', async () => {
    const store = new PostgresSessionStore(database.db);
    await store.createLogin(login(later(60_000)));
    const first = await store.consumeLogin('state-hash-1', NOW);
    expect(first).toMatchObject({ codeVerifier: 'verifier', nonce: 'nonce', returnTo: '/connections', fresh: false });
    await expect(store.consumeLogin('state-hash-1', NOW)).resolves.toBeUndefined();
  });

  it('returns undefined for an expired login state and deletes it', async () => {
    const store = new PostgresSessionStore(database.db);
    await store.createLogin(login(later(-1)));
    await expect(store.consumeLogin('state-hash-1', NOW)).resolves.toBeUndefined();
    const rows = await database.pool.query('SELECT 1 FROM web_login');
    expect(rows.rowCount).toBe(0);
  });

  it('finds a session by hash from a second connection', async () => {
    await new PostgresSessionStore(database.db).createSession(session(later(60_000)));
    const found = await new PostgresSessionStore(second.db).findSession('id-hash-1', NOW);
    expect(found).toEqual(session(later(60_000)));
  });

  it('returns undefined for an expired session', async () => {
    const store = new PostgresSessionStore(database.db);
    await store.createSession(session(later(-1)));
    await expect(store.findSession('id-hash-1', NOW)).resolves.toBeUndefined();
  });

  it('deletes a session and purges expired rows', async () => {
    const store = new PostgresSessionStore(database.db);
    await store.createSession(session(later(60_000)));
    await store.deleteSession('id-hash-1');
    await expect(store.findSession('id-hash-1', NOW)).resolves.toBeUndefined();

    await store.createSession(session(later(-1)));
    await store.createLogin(login(later(-1)));
    await expect(store.purgeExpired(NOW)).resolves.toBe(2);
  });

  it('omits username when the session has none', async () => {
    const store = new PostgresSessionStore(database.db);
    const withName = session(later(60_000));
    await store.createSession({
      idHash: withName.idHash,
      subject: withName.subject,
      clientId: withName.clientId,
      groups: withName.groups,
      authTime: withName.authTime,
      csrfToken: withName.csrfToken,
      expiresAt: withName.expiresAt,
    });
    const found = await store.findSession('id-hash-1', NOW);
    expect(found).toBeDefined();
    expect(found !== undefined && 'username' in found).toBe(false);
  });
});
