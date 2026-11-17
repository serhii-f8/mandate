import { randomUUID } from 'node:crypto';
import { InMemoryTaskRepository } from './in-memory-task-repository.js';
import { describeTaskRepositoryContract } from './task-repository-contract.js';

describeTaskRepositoryContract('in-memory', () =>
  Promise.resolve({ tasks: new InMemoryTaskRepository(), changesetId: () => Promise.resolve(randomUUID()) }),
);
