// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** Fixed Temporal payload key for tests and committed workflow fixtures only (SEC-4); never a real key. */
export const TEST_TEMPORAL_KEYS = `1:${Buffer.from('test-only-temporal-key-000000000').toString('base64')}`;
