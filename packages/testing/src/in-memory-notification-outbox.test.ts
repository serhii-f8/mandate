// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryNotificationOutbox } from './in-memory-notification-outbox.js';
import { describeNotificationOutboxContract } from './notification-outbox-contract.js';

describeNotificationOutboxContract('in-memory', () => {
  const audit = new InMemoryAuditLog();
  const outbox = new InMemoryNotificationOutbox(audit);
  return Promise.resolve({
    outbox,
    seed: (notifications, at) => {
      const changesetId = randomUUID();
      outbox.enqueue(changesetId, notifications, at);
      return Promise.resolve(changesetId);
    },
    seedInto: (changesetId, notifications, at) => {
      outbox.enqueue(changesetId, notifications, at);
      return Promise.resolve();
    },
    auditEvents: (changesetId) => Promise.resolve(audit.events.filter((e) => e.changesetId === changesetId)),
  });
});
