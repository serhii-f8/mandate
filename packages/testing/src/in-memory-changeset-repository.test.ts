// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describeApprovalRepositoryContract } from './approval-repository-contract.js';
import { describeChangeSetRepositoryContract, type ChangeSetRepositoryHarness } from './changeset-repository-contract.js';
import { InMemoryFileStore } from './in-memory-file-store.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';

function setup(): Promise<ChangeSetRepositoryHarness> {
  const audit = new InMemoryAuditLog();
  const files = new InMemoryFileStore();
  const repository = new InMemoryChangeSetRepository(audit, undefined, { files });
  return Promise.resolve({
    repository,
    files,
    auditEvents: () => Promise.resolve([...audit.events]),
    failNextAudit: () => {
      audit.failNext = new Error('audit down');
    },
    notifications: (changesetId) => repository.outbox.listFor(changesetId),
  });
}

describeChangeSetRepositoryContract('in-memory', setup);
describeApprovalRepositoryContract('in-memory', setup);
