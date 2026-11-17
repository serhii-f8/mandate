import { InMemoryRateCounter } from './in-memory-rate-counter.js';
import { describeRateCounterContract } from './rate-counter-contract.js';

describeRateCounterContract('in-memory', () => Promise.resolve({ counter: new InMemoryRateCounter() }));
