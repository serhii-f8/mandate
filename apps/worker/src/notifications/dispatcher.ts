import type { LoadedConfiguration, NotificationConfig } from '@aiops/config';
import {
  afterFailure,
  NOTIFICATION_CLAIM_LIMIT,
  NOTIFICATION_DISPATCH_INTERVAL_MS,
  NOTIFICATION_LEASE_MS,
  notificationAuditEvent,
  renderNotification,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type NotificationError,
  type NotificationOutbox,
  type NotificationRow,
} from '@aiops/core';
import type { Logger } from 'pino';
import type { EmailSender, SendOutcome, WebhookSender, WebhookTarget } from './senders.js';

export interface DispatcherDeps {
  readonly outbox: NotificationOutbox;
  readonly repository: Pick<ChangeSetRepository, 'get' | 'approvals'>;
  readonly configuration: () => LoadedConfiguration;
  /** Absent when `AIOPS_SMTP_URL` is not set: e-mail rows fail with `channel_unconfigured`. */
  readonly email?: EmailSender;
  readonly webhook: WebhookSender;
  /** Origin without trailing slash. */
  readonly publicUrl: string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Pause between passes; default NOTIFICATION_DISPATCH_INTERVAL_MS. */
  readonly intervalMs?: number;
}

export interface PassResult {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
}

export interface NotificationDispatcher {
  /** One claim and its concurrent sends; never throws (store errors are logged with a fixed message). */
  runOnce(): Promise<PassResult>;
  /** Loops runOnce every intervalMs until stop() resolves after the running pass. */
  start(): { stop(): Promise<void> };
}

type WebhookConfig = Extract<NotificationConfig, { kind: 'webhook' }>;

/** The configured webhook notification as the sender takes it (ruling N6). */
export function webhookTargetOf(n: WebhookConfig): WebhookTarget {
  return {
    id: n.id,
    urlCredentialRef: n.url_credential_ref,
    allowedHosts: n.allowed_hosts ?? [],
    allowPrivateNetwork: n.allow_private_network,
  };
}

/** What became of one row; `lease_lost` when the mark was fenced (another dispatcher re-claimed it). */
type RowOutcome = 'sent' | 'retried' | 'failed' | 'lease_lost';

const fail = (error: NotificationError): SendOutcome => ({ ok: false, error });

/**
 * NTF-3 delivery beside the Temporal worker: claims due outbox rows under a lease, sends all rows
 * of a claim concurrently (so a claim never outlives its lease, NFR-4), and records the outcome
 * through the fenced marks. It never touches change-set state. Errors reach logs, audit and the
 * outbox only as the fixed codes (SEC-3).
 */
export function createNotificationDispatcher(deps: DispatcherDeps): NotificationDispatcher {
  const intervalMs = deps.intervalMs ?? NOTIFICATION_DISPATCH_INTERVAL_MS;

  /** Renders and sends one row; any throw (store, render, sender) is `internal`. */
  async function deliver(row: NotificationRow): Promise<{ outcome: SendOutcome; changeset?: ChangeSetRecord }> {
    try {
      const configuration = deps.configuration();
      const target = configuration.notifications.find((n) => n.id === row.target);
      if (target === undefined) return { outcome: fail('target_unknown') };
      const changeset = await deps.repository.get(row.changesetId);
      if (changeset === undefined) return { outcome: fail('internal') };
      const decision =
        row.kind === 'approval_decided'
          ? (await deps.repository.approvals(row.changesetId, row.round)).find((a) => a.step === row.step)
          : undefined;
      const title = configuration.policy.operations.find((o) => o.id === changeset.operation)?.title;
      const rendered = renderNotification({
        row,
        changeset,
        publicUrl: deps.publicUrl,
        ...(title === undefined ? {} : { operationTitle: title }),
        ...(decision === undefined ? {} : { decision }),
      });
      if (target.kind === 'email') {
        if (deps.email === undefined) return { outcome: fail('channel_unconfigured'), changeset };
        return { outcome: await deps.email.send({ to: target.to, subject: rendered.subject, text: rendered.text }), changeset };
      }
      return { outcome: await deps.webhook.send(webhookTargetOf(target), rendered.text), changeset };
    } catch {
      // The thrown text may carry the URL, a recipient or the server's reply; only the code is kept.
      return { outcome: fail('internal') };
    }
  }

  /** The correlation ID of the audit event: the change-set's, or a fresh read when delivery did not load it. */
  async function correlationOf(row: NotificationRow, changeset: ChangeSetRecord | undefined): Promise<string> {
    if (changeset !== undefined) return changeset.correlationId;
    const stored = await deps.repository.get(row.changesetId);
    // The outbox references the change-set, so it exists; the row ID keeps the event traceable otherwise.
    return stored?.correlationId ?? row.id;
  }

  async function record(row: NotificationRow, delivered: { outcome: SendOutcome; changeset?: ChangeSetRecord }): Promise<RowOutcome> {
    const attempt = row.attempts;
    const { outcome } = delivered;
    if (outcome.ok) {
      const audit = notificationAuditEvent({
        id: deps.newId(),
        row,
        outcome: 'sent',
        correlationId: await correlationOf(row, delivered.changeset),
      });
      return (await deps.outbox.markSent({ id: row.id, attempt, now: deps.now(), audit })) ? 'sent' : 'lease_lost';
    }
    const next = afterFailure(attempt);
    if (next.kind === 'retry') {
      const nextAttemptAt = new Date(deps.now().getTime() + next.delayMs);
      return (await deps.outbox.markRetry({ id: row.id, attempt, error: outcome.error, nextAttemptAt })) ? 'retried' : 'lease_lost';
    }
    const audit = notificationAuditEvent({
      id: deps.newId(),
      row,
      outcome: 'failed',
      error: outcome.error,
      correlationId: await correlationOf(row, delivered.changeset),
    });
    return (await deps.outbox.markFailed({ id: row.id, attempt, error: outcome.error, audit })) ? 'failed' : 'lease_lost';
  }

  async function handle(row: NotificationRow): Promise<RowOutcome | undefined> {
    const delivered = await deliver(row);
    const error = delivered.outcome.ok ? undefined : delivered.outcome.error;
    let outcome: RowOutcome;
    try {
      outcome = await record(row, delivered);
    } catch {
      // The lease runs out and the row is claimed again; the store's message can name the database.
      deps.logger.error({ notification: row.id }, 'notification mark failed');
      return undefined;
    }
    deps.logger.info(
      {
        notification: row.id,
        kind: row.kind,
        target: row.target,
        attempts: row.attempts,
        outcome,
        ...(error === undefined ? {} : { error }),
      },
      'notification attempt',
    );
    return outcome;
  }

  async function runOnce(): Promise<PassResult> {
    let rows: readonly NotificationRow[];
    try {
      rows = await deps.outbox.claim({ now: deps.now(), limit: NOTIFICATION_CLAIM_LIMIT, leaseMs: NOTIFICATION_LEASE_MS });
    } catch {
      deps.logger.error({}, 'notification claim failed');
      return { claimed: 0, sent: 0, retried: 0, failed: 0 };
    }
    // All rows at once: 20 sequential sends of up to 10 s each would outlive the 120 s lease (NFR-4).
    const outcomes = await Promise.all(rows.map(handle));
    const count = (o: RowOutcome): number => outcomes.filter((x) => x === o).length;
    return { claimed: rows.length, sent: count('sent'), retried: count('retried'), failed: count('failed') };
  }

  function start(): { stop(): Promise<void> } {
    // An object, so the loop re-reads the flag that stop() sets across the awaits.
    const state: { stopping: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void } = { stopping: false };
    const pause = (): Promise<void> =>
      new Promise<void>((resolve) => {
        state.wake = resolve;
        state.timer = setTimeout(resolve, intervalMs);
      });
    const loop = (async () => {
      do {
        await runOnce();
        if (!state.stopping) await pause();
      } while (!state.stopping);
    })();
    return {
      async stop() {
        state.stopping = true;
        clearTimeout(state.timer);
        state.wake?.();
        await loop;
      },
    };
  }

  return { runOnce, start };
}
