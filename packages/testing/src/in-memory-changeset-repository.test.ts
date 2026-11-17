import { describeChangeSetRepositoryContract } from './changeset-repository-contract.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';

describeChangeSetRepositoryContract('in-memory', () => {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  return Promise.resolve({
    repository,
    auditEvents: () => Promise.resolve([...audit.events]),
    failNextAudit: () => {
      audit.failNext = new Error('audit down');
    },
  });
});
