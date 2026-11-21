// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { InMemoryRateCounter } from './in-memory-rate-counter.js';
import { describeRateCounterContract } from './rate-counter-contract.js';

describeRateCounterContract('in-memory', () => Promise.resolve({ counter: new InMemoryRateCounter() }));
