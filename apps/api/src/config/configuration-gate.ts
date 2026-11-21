// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { NextFunction, Request, Response } from 'express';
import type { ConfigurationStateSource } from '@aiops/config';

/** Reachable in every state, so Compose and the operator can see the process (NFR-10). GET only. */
const EXEMPT_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * CFG-2, SEC-1: while no configuration is active (state `none` or `configuration_mismatch`),
 * every request but `GET /healthz`, `GET /readyz` and `GET /metrics` answers 503
 * `{"error":"configuration_unavailable"}`, never cached. Nothing behind the gate can then read
 * a configuration that does not exist. The state is read per request, so a revision that
 * becomes active is served at once.
 */
export function configurationGate(source: ConfigurationStateSource): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (source.state().status === 'active' || (req.method === 'GET' && EXEMPT_PATHS.has(req.path))) {
      next();
      return;
    }
    res.status(503).set('cache-control', 'no-store').json({ error: 'configuration_unavailable' });
  };
}
