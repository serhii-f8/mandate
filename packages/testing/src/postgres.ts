/**
 * Real PostgreSQL for integration and e2e tests (NFR-15): one container per test
 * file, a fresh database per test that asks for one. No mocked database.
 */
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_IMAGE = 'postgres:17';

export interface StartedPostgres {
  /** Creates an empty database and returns its connection URL. */
  createDatabase(): Promise<string>;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = container.getConnectionUri();
  return {
    async createDatabase() {
      const name = `t_${randomUUID().replaceAll('-', '')}`;
      await container.exec(['psql', '-U', container.getUsername(), '-d', container.getDatabase(), '-c', `CREATE DATABASE ${name}`]);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async stop() {
      await container.stop();
    },
  };
}
