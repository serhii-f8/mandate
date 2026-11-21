// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { InMemoryTaskRepository } from './in-memory-task-repository.js';
import { describeTaskRepositoryContract } from './task-repository-contract.js';

describeTaskRepositoryContract('in-memory', () =>
  Promise.resolve({ tasks: new InMemoryTaskRepository(), changesetId: () => Promise.resolve(randomUUID()) }),
);
