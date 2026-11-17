import type { ExecutionGuard } from '@aiops/core';

/**
 * Execution guard that lets every change-set run. The executor contract harness uses it: its
 * change-sets carry a fixed hash and no configuration, so the production guard has its own tests.
 */
export const allowAllGuard: ExecutionGuard = {
  check: () => Promise.resolve({ ok: true }),
};
