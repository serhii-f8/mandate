/**
 * The worker's HTTP server (NFR-10, NFR-12): `/healthz` (alive), `/readyz` (database, configuration
 * and a running Temporal worker) and `/metrics` (the Prometheus exporter). Only `GET` on exactly
 * these paths is served; anything else is 405 or 404 with a fixed body, never an echo of the
 * request. Compose does not publish the port.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readinessStatus, type ReadinessReport } from '@aiops/config';

export interface WorkerHttpDeps {
  readonly readiness: () => Promise<ReadinessReport>;
  readonly metrics: (req: IncomingMessage, res: ServerResponse) => void;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function ready(deps: WorkerHttpDeps, res: ServerResponse): Promise<void> {
  let report: ReadinessReport;
  try {
    report = await deps.readiness();
  } catch {
    // The probe's own failure detail is not reported (SEC-3); the worker is simply not ready.
    json(res, 503, { ready: false }, { 'cache-control': 'no-store' });
    return;
  }
  // The worker needs Temporal: a worker that does not poll is not ready (NFR-10).
  json(res, readinessStatus(report, true), report, { 'cache-control': 'no-store' });
}

function handle(deps: WorkerHttpDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    return;
  }
  // Exact match on the raw target: a query string or any other variant is a different path.
  switch (req.url) {
    case '/healthz':
      json(res, 200, { ok: true });
      return;
    case '/readyz':
      void ready(deps, res);
      return;
    case '/metrics':
      deps.metrics(req, res);
      return;
    default:
      json(res, 404, { error: 'not_found' });
  }
}

/** Listens on `host:port` (port 0: an ephemeral port); resolves once listening, rejects when the bind fails. */
export function startWorkerHttpServer(
  port: number,
  host: string,
  deps: WorkerHttpDeps,
): Promise<{ readonly port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    try {
      handle(deps, req, res);
    } catch {
      // A throwing metrics handler must not end the process.
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      reject(error);
    };
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      const address = server.address() as AddressInfo; // a TCP listener always has an AddressInfo
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            // Keep-alive connections (a scraper) would hold close() open.
            server.closeAllConnections();
          }),
      });
    });
  });
}
