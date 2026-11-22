// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** One migrated PostgreSQL database per test file (NFR-15): a real database, never a mock. */
import { createDb, runMigrations, type Database } from '@mandate/db';
import { startPostgres } from '@mandate/testing';

export interface TestPostgres {
  readonly url: string;
  readonly database: Database;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const postgres = await startPostgres();
  try {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const database = createDb(url, { onError: () => undefined });
    return {
      url,
      database,
      async stop() {
        await database.close();
        await postgres.stop();
      },
    };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}

export interface StoredAuditEvent {
  readonly actor: string;
  readonly clientId: string | null;
  readonly action: string;
  readonly decision: string | null;
  readonly outcome: string;
  readonly correlationId: string;
  readonly changesetId: string | null;
  readonly details: Record<string, unknown>;
}

/** Audit events of one change-set in append order. */
export async function auditEventsOf(database: Database, changesetId: string): Promise<StoredAuditEvent[]> {
  const result = await database.pool.query<StoredAuditEvent>(
    `SELECT actor, client_id AS "clientId", action, decision, outcome, correlation_id AS "correlationId",
            changeset_id AS "changesetId", details
       FROM audit_event WHERE changeset_id = $1 ORDER BY seq`,
    [changesetId],
  );
  return result.rows;
}
