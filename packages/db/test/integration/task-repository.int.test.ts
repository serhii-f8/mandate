import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { describeTaskRepositoryContract, startPostgres, type StartedPostgres } from '@aiops/testing';
import { PostgresChangeSetRepository } from '../../src/changeset-repository.js';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { PostgresTaskRepository } from '../../src/task-repository.js';

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

describeTaskRepositoryContract('postgres', () => {
  const changesets = new PostgresChangeSetRepository(database.db);
  return Promise.resolve({
    tasks: new PostgresTaskRepository(database.db),
    changesetId: async () => {
      const id = randomUUID();
      await changesets.create(
        {
          id,
          operation: 'catalog.update',
          connection: 'shop',
          requester: 'alice',
          args: {},
          configHash: 'cfg',
          correlationId: 'corr-task',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2026-01-02T00:00:00.000Z'),
        },
        {
          id: randomUUID(),
          actor: 'alice',
          action: 'changeset.transition',
          outcome: 'ok',
          correlationId: 'corr-task',
          changesetId: id,
          details: {},
        },
      );
      return id;
    },
  });
});
