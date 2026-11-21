import { describe, expect, it } from 'vitest';
import type { Connection } from '@temporalio/client';
import type { ConfigurationStateSource } from '@aiops/config';
import type { Database } from '@aiops/db';
import { HealthController } from './health.controller.js';

const active: ConfigurationStateSource = { state: () => ({ status: 'active', revision: null, hash: 'h1' }) };

function database(query: () => Promise<unknown>): Database {
  return { pool: { query } } as unknown as Database;
}

function connection(check: () => Promise<{ status: number }>): { connection: Connection } {
  const fake = {
    withDeadline: <T>(_deadline: number | Date, fn: () => Promise<T>): Promise<T> => fn(),
    healthService: { check },
  };
  return { connection: fake as unknown as Connection };
}

async function readyz(controller: HealthController): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const out: { status: number; headers: Record<string, string>; body: unknown } = { status: 0, headers: {}, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    set(name: string, value: string) {
      out.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await controller.ready(res as never);
  return out;
}

const dbOk = () => database(() => Promise.resolve({}));

describe('NFR-10 api readiness probes', () => {
  it('NFR-10 Temporal SERVING is ok and the api stays ready', async () => {
    const r = await readyz(new HealthController(dbOk(), active, connection(() => Promise.resolve({ status: 1 }))));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ database: 'ok', configuration: { revision: null, hash: 'h1' }, temporal: 'ok' });
  });

  it('NFR-10 Temporal NOT_SERVING is unavailable, and the api is still ready', async () => {
    const r = await readyz(new HealthController(dbOk(), active, connection(() => Promise.resolve({ status: 2 }))));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ temporal: 'unavailable' });
  });

  it('NFR-10 a rejecting Temporal health check is unavailable, and a missing handle too', async () => {
    const rejecting = await readyz(new HealthController(dbOk(), active, connection(() => Promise.reject(new Error('down')))));
    expect(rejecting.status).toBe(200);
    expect(rejecting.body).toMatchObject({ temporal: 'unavailable' });
    const none = await readyz(new HealthController(dbOk(), active, null));
    expect(none.body).toMatchObject({ temporal: 'unavailable' });
  });

  it('NFR-10 a rejecting database probe is 503 with database unavailable', async () => {
    const r = await readyz(
      new HealthController(database(() => Promise.reject(new Error('db down'))), active, connection(() => Promise.resolve({ status: 1 }))),
    );
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ database: 'unavailable' });
  });
});

describe('NFR-10 api liveness', () => {
  it('NFR-10 /healthz reports the product version', () => {
    expect(new HealthController(dbOk(), active, null).live()).toEqual({ ok: true, version: '1.0.0' });
  });
});
