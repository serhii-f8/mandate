// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { countChangeSetsByStatus } from '../../src/metrics-queries.js';

let postgres: StartedPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  database = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

async function insert(status: string): Promise<void> {
  await database.pool.query(
    `INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at)
     VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'h', $2, '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
    [randomUUID(), status],
  );
}

describe('NFR-12 change-set counts by status', () => {
  it('NFR-12 countChangeSetsByStatus counts per status', async () => {
    expect(await countChangeSetsByStatus(database)).toEqual(new Map());
    await insert('prepared');
    await insert('prepared');
    await insert('completed');
    const counts = await countChangeSetsByStatus(database);
    expect(counts.get('prepared')).toBe(2);
    expect(counts.get('completed')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
