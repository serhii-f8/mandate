import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoadedConfiguration, NotificationConfig } from '@aiops/config';
import { DEFAULT_TUNING } from '@aiops/temporal';
import { insertNotifications, PostgresChangeSetRepository, PostgresNotificationOutbox } from '@aiops/db';
import { allowAllGuard, ScriptedWriter, startSmtpSink, type SmtpSink } from '@aiops/testing';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createActivities } from '../../src/activities/index.js';
import { createNotificationDispatcher, type DispatcherDeps } from '../../src/notifications/dispatcher.js';
import { createSmtpSender } from '../../src/notifications/email.js';
import { createWebhookSender } from '../../src/notifications/webhook.js';
import { createPrepared } from '../support/changesets.js';
import { testConfiguration } from '../support/configuration.js';
import { MemoryVault } from '../support/magento.js';
import { auditEventsOf, startTestPostgres, type TestPostgres } from '../support/postgres.js';

const PUBLIC_URL = 'http://aiops.example.test';

let postgres: TestPostgres;
let repository: PostgresChangeSetRepository;
let outbox: PostgresNotificationOutbox;
let base: LoadedConfiguration;

beforeAll(async () => {
  postgres = await startTestPostgres();
  repository = new PostgresChangeSetRepository(postgres.database.db);
  outbox = new PostgresNotificationOutbox(postgres.database.db);
  base = await testConfiguration();
});

afterAll(async () => {
  await postgres.stop();
});

function configured(notifications: readonly NotificationConfig[], results: readonly string[]): LoadedConfiguration {
  return { ...base, notifications, notify: new Map([['editor', { approvalRequests: [], results }]]) };
}

function deps(configuration: LoadedConfiguration, clock: () => Date, senders: Pick<DispatcherDeps, 'email' | 'webhook'>): DispatcherDeps {
  return {
    outbox,
    repository,
    configuration: () => configuration,
    ...senders,
    publicUrl: PUBLIC_URL,
    newId: randomUUID,
    now: clock,
    logger: pino({ level: 'silent' }),
  };
}

const submission = { actor: 'alice', groups: ['editors'], correlationId: 'corr-submit', at: new Date(), role: 'editor', rule: 'role:editor/grant:all' };

describe('NTF-3 notification delivery on PostgreSQL', () => {
  let server: Server | undefined;
  let sink: SmtpSink | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      const s = server;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => {
        resolve();
      }));
      server = undefined;
    }
    await sink?.close();
    sink = undefined;
  });

  it('NTF-3 a failing webhook retries and ends failed while the change-set completes', async () => {
    let posts = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST') posts += 1;
        res.writeHead(500).end();
      });
    });
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const port = (s.address() as AddressInfo).port;
    const vault = new MemoryVault();
    await vault.put({ ref: 'chat-hook', scheme: 'webhook_url', secret: { url: `http://127.0.0.1:${String(port)}/hook` }, actor: 'test' });
    const configuration = configured(
      [{ id: 'team-chat', kind: 'webhook', url_credential_ref: 'chat-hook', allowed_hosts: ['127.0.0.1'], allow_private_network: true }],
      ['team-chat'],
    );

    const cs = await createPrepared(repository, 1, { execute: { submission } });
    const activities = createActivities({
      repository,
      configuration: () => configuration,
      writerFor: () => new ScriptedWriter(),
      readerFor: () => {
        throw new Error('no reads in this test');
      },
      guardFor: () => allowAllGuard,
      tuning: DEFAULT_TUNING,
      newId: randomUUID,
      now: () => new Date(),
    });
    const env = new MockActivityEnvironment({ attempt: 1 }, { logger: new DefaultLogger('ERROR') });
    await env.run(() => activities.executeBatch(cs.id, 0));
    await expect(env.run(() => activities.finishExecution(cs.id, 'done'))).resolves.toEqual({ status: 'completed' });

    // The row was stamped with the wall clock; the fake clock starts at or after it.
    let clock = new Date();
    const dispatcher = createNotificationDispatcher(deps(configuration, () => clock, { webhook: createWebhookSender({ vault }) }));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [row] = await outbox.listFor(cs.id);
      if (row === undefined) throw new Error('row missing');
      if (row.nextAttemptAt.getTime() > clock.getTime()) clock = row.nextAttemptAt;
      await expect(dispatcher.runOnce()).resolves.toMatchObject({ claimed: 1 });
    }

    expect(posts).toBe(8);
    const rows = await outbox.listFor(cs.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'execution_finished', state: 'failed', attempts: 8, lastError: 'http_status' });
    const stored = await postgres.database.pool.query<{ last_error: string }>('SELECT last_error FROM notification_outbox WHERE changeset_id = $1', [cs.id]);
    expect(stored.rows).toEqual([{ last_error: 'http_status' }]);
    const failed = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action.startsWith('notification.'));
    expect(failed).toEqual([
      expect.objectContaining({
        action: 'notification.failed',
        outcome: 'error',
        details: { kind: 'execution_finished', target: 'team-chat', attempts: 8, error: 'http_status' },
      }),
    ]);
    expect((await repository.get(cs.id))?.status).toBe('completed');
  });

  it('NFR-4 two dispatchers on one database never send a row twice within a lease', async () => {
    sink = await startSmtpSink();
    const configuration = configured([{ id: 'ops-mail', kind: 'email', to: ['ops@example.test'] }], ['ops-mail']);
    const at = new Date();
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const cs = await createPrepared(repository, 1);
      ids.push(cs.id);
      await insertNotifications(postgres.database.db, cs.id, [{ kind: 'execution_finished', round: 0, step: 0, target: 'ops-mail' }], at);
    }
    const now = new Date(Math.max(Date.now(), at.getTime()));
    const email = createSmtpSender({ url: sink.url, from: 'aiops@example.test' });
    let clock = now;
    const a = createNotificationDispatcher(deps(configuration, () => clock, { email, webhook: createWebhookSender({ vault: new MemoryVault() }) }));
    const b = createNotificationDispatcher(deps(configuration, () => clock, { email, webhook: createWebhookSender({ vault: new MemoryVault() }) }));
    try {
      // Thirty rows and a claim limit of twenty: both claims are disjoint and together take all thirty.
      const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
      expect(ra.claimed + rb.claimed).toBe(30);
      expect(ra.sent + rb.sent).toBe(30);
      expect(sink.messages).toHaveLength(30);
      // Quoted-printable soft line breaks are removed before the link is read.
      const links = sink.messages.map((m) => /\/app\/changesets\/([0-9a-f-]{36})/.exec(m.data.replace(/=\r\n/g, ''))?.[1]);
      expect(new Set(links)).toEqual(new Set(ids));

      clock = new Date(now.getTime() + 60_000);
      const [again1, again2] = await Promise.all([a.runOnce(), b.runOnce()]);
      expect(again1.claimed + again2.claimed).toBe(0);
      expect(sink.messages).toHaveLength(30);
    } finally {
      email.close();
    }
  });
});
