// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration, NotificationConfig } from '@mandate/config';
import { renderNotification, type ChangeSetRecord, type NewNotification, type NotificationOutbox, type NotificationRow } from '@mandate/core';
import { InMemoryChangeSetRepository, recordApproval, submitChangeSet } from '@mandate/testing';
import type { Logger } from 'pino';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrepared } from '../../test/support/changesets.js';
import { testConfiguration, WRITE_OPERATION } from '../../test/support/configuration.js';
import { createNotificationDispatcher, type DispatcherDeps } from './dispatcher.js';
import type { EmailSender, SendOutcome, WebhookSender, WebhookTarget } from './senders.js';

const PUBLIC_URL = 'http://mandate.example.test';
const RECIPIENT = 'ops-team@example.test';
const OPERATION_TITLE = 'Update product content';

const MAIL: NotificationConfig = { id: 'ops-mail', kind: 'email', to: [RECIPIENT] };
const HOOK: NotificationConfig = {
  id: 'team-chat',
  kind: 'webhook',
  url_credential_ref: 'chat-hook',
  allowed_hosts: ['hooks.example.test'],
  allow_private_network: false,
};

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly obj: unknown;
  readonly msg: unknown;
}

class RecordingEmail implements EmailSender {
  readonly calls: { to: readonly string[]; subject: string; text: string }[] = [];
  answer: () => Promise<SendOutcome> = () => Promise.resolve({ ok: true });
  send(mail: { to: readonly string[]; subject: string; text: string }): Promise<SendOutcome> {
    this.calls.push(mail);
    return this.answer();
  }
  close(): void {
    // nothing to close
  }
}

class RecordingWebhook implements WebhookSender {
  readonly calls: { target: WebhookTarget; text: string }[] = [];
  answer: () => Promise<SendOutcome> = () => Promise.resolve({ ok: true });
  send(target: WebhookTarget, text: string): Promise<SendOutcome> {
    this.calls.push({ target, text });
    return this.answer();
  }
}

let base: LoadedConfiguration;
let repository: InMemoryChangeSetRepository;
let email: RecordingEmail;
let webhook: RecordingWebhook;
let lines: LogLine[];
let clock: Date;
let configuration: LoadedConfiguration;

function withNotifications(notifications: readonly NotificationConfig[]): LoadedConfiguration {
  return {
    ...base,
    notifications,
    policy: {
      ...base.policy,
      operations: base.policy.operations.map((o) => (o.id === WRITE_OPERATION ? { ...o, title: OPERATION_TITLE } : o)),
    },
  };
}

function recordingLogger(): Pick<Logger, 'info' | 'warn' | 'error'> {
  const at = (level: LogLine['level']) => (obj: unknown, msg?: unknown) => {
    lines.push({ level, obj, msg });
  };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

function deps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    outbox: repository.outbox,
    repository,
    configuration: () => configuration,
    email,
    webhook,
    publicUrl: PUBLIC_URL,
    newId: randomUUID,
    now: () => clock,
    logger: recordingLogger(),
    ...overrides,
  };
}

function dispatcher(overrides: Partial<DispatcherDeps> = {}) {
  return createNotificationDispatcher(deps(overrides));
}

/** A prepared change-set with one queued `execution_finished` row per target, due at `clock`. */
async function queued(targets: readonly string[]): Promise<ChangeSetRecord> {
  const cs = await createPrepared(repository, 1);
  const rows: NewNotification[] = targets.map((target) => ({ kind: 'execution_finished', round: 0, step: 0, target }));
  repository.outbox.enqueue(cs.id, rows, clock);
  return cs;
}

function rowsOf(changesetId: string): NotificationRow[] {
  return repository.outbox.all().filter((r) => r.changesetId === changesetId);
}

/** The outbox with some methods replaced. */
function delegating(outbox: NotificationOutbox, overrides: Partial<NotificationOutbox>): NotificationOutbox {
  return {
    claim: (req) => outbox.claim(req),
    markSent: (req) => outbox.markSent(req),
    markRetry: (req) => outbox.markRetry(req),
    markFailed: (req) => outbox.markFailed(req),
    listFor: (id) => outbox.listFor(id),
    ...overrides,
  };
}

function only(changesetId: string): NotificationRow {
  const [row, ...rest] = rowsOf(changesetId);
  if (row === undefined || rest.length > 0) throw new Error('expected exactly one row');
  return row;
}

beforeAll(async () => {
  base = await testConfiguration();
});

beforeEach(() => {
  repository = new InMemoryChangeSetRepository();
  email = new RecordingEmail();
  webhook = new RecordingWebhook();
  lines = [];
  clock = new Date('2026-11-18T10:00:00.000Z');
  configuration = withNotifications([MAIL, HOOK]);
});

describe('NTF-3 notification dispatcher', () => {
  it('NTF-1 runOnce renders and sends a due row by email and marks it sent with notification.sent', async () => {
    const cs = await queued(['ops-mail']);
    await expect(dispatcher().runOnce()).resolves.toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });

    const stored = await repository.get(cs.id);
    if (stored === undefined) throw new Error('change-set missing');
    const expected = renderNotification({
      row: { kind: 'execution_finished', round: 0, step: 0 },
      changeset: stored,
      operationTitle: OPERATION_TITLE,
      publicUrl: PUBLIC_URL,
    });
    expect(email.calls).toEqual([{ to: [RECIPIENT], subject: expected.subject, text: expected.text }]);
    expect(only(cs.id)).toMatchObject({ state: 'sent', attempts: 1 });
    const audit = repository.audit.events.filter((e) => e.action.startsWith('notification.'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'notification.sent',
      actor: 'system',
      subject: 'ops-mail',
      outcome: 'ok',
      changesetId: cs.id,
      correlationId: cs.correlationId,
      details: { kind: 'execution_finished', target: 'ops-mail', attempts: 1 },
    });
    expect(lines).toContainEqual({
      level: 'info',
      obj: { notification: only(cs.id).id, kind: 'execution_finished', target: 'ops-mail', attempts: 1, outcome: 'sent' },
      msg: 'notification attempt',
    });
  });

  it('NTF-1 a webhook row is sent with the configured target mapped to WebhookTarget', async () => {
    configuration = withNotifications([MAIL, HOOK, { id: 'bare-hook', kind: 'webhook', url_credential_ref: 'bare', allow_private_network: false }]);
    const cs = await queued(['team-chat', 'bare-hook']);
    await expect(dispatcher().runOnce()).resolves.toMatchObject({ claimed: 2, sent: 2 });
    const stored = await repository.get(cs.id);
    if (stored === undefined) throw new Error('change-set missing');
    const { text } = renderNotification({ row: { kind: 'execution_finished', round: 0, step: 0 }, changeset: stored, operationTitle: OPERATION_TITLE, publicUrl: PUBLIC_URL });
    expect(webhook.calls.map((c) => c.target).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'bare-hook', urlCredentialRef: 'bare', allowedHosts: [], allowPrivateNetwork: false },
      { id: 'team-chat', urlCredentialRef: 'chat-hook', allowedHosts: ['hooks.example.test'], allowPrivateNetwork: false },
    ]);
    expect(webhook.calls.map((c) => c.text)).toEqual([text, text]);
    expect(email.calls).toEqual([]);
  });

  it('NTF-1 approval_decided renders the decision of its round and step', async () => {
    const prepared = await createPrepared(repository, 1);
    const pending = await submitChangeSet(repository, prepared, { steps: ['lead', 'owner'] });
    const afterFirst = await recordApproval(repository, pending, { approver: 'carol' });
    await recordApproval(repository, afterFirst, { approver: 'dave', decision: 'rejected' });
    repository.outbox.enqueue(prepared.id, [{ kind: 'approval_decided', round: 1, step: 2, target: 'ops-mail' }], clock);

    await expect(dispatcher().runOnce()).resolves.toMatchObject({ sent: 1 });
    expect(email.calls[0]?.text).toContain('was rejected by dave at step 2.');
  });

  it('NTF-3 a failing channel is retried on the schedule and fails after 8 attempts', async () => {
    webhook.answer = () => Promise.resolve({ ok: false, error: 'http_status' });
    const cs = await queued(['team-chat']);
    const statusBefore = (await repository.get(cs.id))?.status;
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      clock = only(cs.id).nextAttemptAt;
      await dispatcher().runOnce();
      const row = only(cs.id);
      if (row.state === 'pending') gaps.push(row.nextAttemptAt.getTime() - clock.getTime());
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
    expect(webhook.calls).toHaveLength(8);
    expect(only(cs.id)).toMatchObject({ state: 'failed', attempts: 8, lastError: 'http_status' });
    const audit = repository.audit.events.filter((e) => e.action.startsWith('notification.'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'notification.failed',
      outcome: 'error',
      details: { kind: 'execution_finished', target: 'team-chat', attempts: 8, error: 'http_status' },
    });
    expect((await repository.get(cs.id))?.status).toBe(statusBefore);
  });

  it('NTF-3 email rows fail with channel_unconfigured without an SMTP sender', async () => {
    const cs = await queued(['ops-mail']);
    const { email: _omitted, ...withoutEmail } = deps(); // eslint-disable-line @typescript-eslint/no-unused-vars -- no SMTP sender configured
    await expect(createNotificationDispatcher(withoutEmail).runOnce()).resolves.toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(only(cs.id)).toMatchObject({ state: 'pending', attempts: 1, lastError: 'channel_unconfigured' });
    expect(email.calls).toEqual([]);
  });

  it('NTF-3 a target removed by a reload fails target_unknown and other rows are still sent', async () => {
    const cs = await queued(['ops-mail', 'team-chat']);
    configuration = withNotifications([MAIL]);
    await expect(dispatcher().runOnce()).resolves.toEqual({ claimed: 2, sent: 1, retried: 1, failed: 0 });
    const byTarget = Object.fromEntries(rowsOf(cs.id).map((r) => [r.target, r]));
    expect(byTarget['ops-mail']).toMatchObject({ state: 'sent' });
    expect(byTarget['team-chat']).toMatchObject({ state: 'pending', lastError: 'target_unknown' });
    expect(webhook.calls).toEqual([]);
  });

  it('NTF-3 a sender that throws becomes internal and runOnce resolves', async () => {
    webhook.answer = () => Promise.reject(new Error(`boom ${RECIPIENT}`));
    const cs = await queued(['team-chat']);
    await expect(dispatcher().runOnce()).resolves.toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(only(cs.id)).toMatchObject({ state: 'pending', lastError: 'internal' });
    expect(JSON.stringify(lines)).not.toContain('boom');
  });

  it('NTF-3 a store failure is logged with a fixed message and runOnce resolves', async () => {
    const failing = delegating(repository.outbox, { claim: () => Promise.reject(new Error('connection lost to db.internal')) });
    await expect(dispatcher({ outbox: failing }).runOnce()).resolves.toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
    expect(lines).toEqual([{ level: 'error', obj: {}, msg: 'notification claim failed' }]);
  });

  it('NFR-4 the rows of one claim are sent concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    let open: () => void = () => undefined; // replaced synchronously by the Promise executor
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    webhook.answer = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return { ok: true };
    };
    for (let i = 0; i < 5; i += 1) await queued(['team-chat']);
    const pass = dispatcher().runOnce();
    try {
      await vi.waitFor(() => {
        expect(inFlight).toBe(5);
      });
    } finally {
      open();
    }
    await expect(pass).resolves.toEqual({ claimed: 5, sent: 5, retried: 0, failed: 0 });
    expect(peak).toBe(5);
  });

  it('SEC-3 no log line or audit row carries the rendered text, the recipients or the webhook URL', async () => {
    const hookUrl = 'https://hooks.example.test/services/T000/B000/SECRETPART';
    webhook.answer = () => Promise.reject(new Error(`request to ${hookUrl} failed`));
    email.answer = () => Promise.reject(new Error(`550 ${RECIPIENT} rejected`));
    const okCs = await queued(['ops-mail']);
    const failCs = await queued(['team-chat']);
    const d = dispatcher();
    await d.runOnce();
    email.answer = () => Promise.resolve({ ok: true });
    clock = new Date(clock.getTime() + 60_000);
    await d.runOnce();

    const audit = repository.audit.events;
    const stored = await repository.get(okCs.id);
    if (stored === undefined) throw new Error('change-set missing');
    const rendered = renderNotification({
      row: { kind: 'execution_finished', round: 0, step: 0 },
      changeset: stored,
      operationTitle: OPERATION_TITLE,
      publicUrl: PUBLIC_URL,
    });
    expect(only(okCs.id).state).toBe('sent');
    expect(only(failCs.id).lastError).toBe('internal');
    for (const haystack of [JSON.stringify(lines), JSON.stringify(audit)]) {
      expect(haystack).not.toContain(rendered.text);
      expect(haystack).not.toContain(rendered.subject);
      expect(haystack).not.toContain(RECIPIENT);
      expect(haystack).not.toContain(hookUrl);
      expect(haystack).not.toContain('SECRETPART');
      expect(haystack).not.toContain(PUBLIC_URL);
    }
  });

  it('NTF-3 stop() waits for the running pass and stops the loop', async () => {
    let claims = 0;
    const outbox = repository.outbox;
    const counting = delegating(outbox, {
      claim: (req) => {
        claims += 1;
        return outbox.claim(req);
      },
    });
    let open: () => void = () => undefined; // replaced synchronously by the Promise executor
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = false;
    webhook.answer = async () => {
      reached = true;
      await gate;
      return { ok: true };
    };
    // Fake timers: the 10 ms interval advances on demand, so "no further pass" is not a wall-clock window.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const loop = createNotificationDispatcher(deps({ outbox: counting, intervalMs: 10 })).start();
      await vi.advanceTimersByTimeAsync(25);
      expect(claims).toBe(3);
      const cs = await queued(['team-chat']);
      await vi.advanceTimersByTimeAsync(10);
      expect(reached).toBe(true);

      let stopped = false;
      const stopping = loop.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false);
      expect(only(cs.id).state).toBe('pending');
      open();
      await stopping;
      expect(only(cs.id).state).toBe('sent');

      const after = claims;
      const later = await queued(['team-chat']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(claims).toBe(after);
      expect(only(later.id).state).toBe('pending');
    } finally {
      open();
      vi.useRealTimers();
    }
  });
});
