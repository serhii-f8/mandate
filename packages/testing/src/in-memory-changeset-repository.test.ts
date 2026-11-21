// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describeApprovalRepositoryContract } from './approval-repository-contract.js';
import { describeChangeSetRepositoryContract, type ChangeSetRepositoryHarness } from './changeset-repository-contract.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';

function setup(): Promise<ChangeSetRepositoryHarness> {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  return Promise.resolve({
    repository,
    auditEvents: () => Promise.resolve([...audit.events]),
    failNextAudit: () => {
      audit.failNext = new Error('audit down');
    },
    notifications: (changesetId) => repository.outbox.listFor(changesetId),
  });
}

describeChangeSetRepositoryContract('in-memory', setup);
describeApprovalRepositoryContract('in-memory', setup);
