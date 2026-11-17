import { afterAll, beforeAll } from 'vitest';
import { describeRateCounterContract, startPostgres, type StartedPostgres } from '@aiops/testing';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { PostgresRateCounter } from '../../src/rate-counter.js';

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

// One database for the whole suite; the contract uses fresh keys in every case.
describeRateCounterContract('postgres', () => Promise.resolve({ counter: new PostgresRateCounter(database.db) }));
