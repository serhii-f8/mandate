// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Hop-by-hop headers are per connection and must not be relayed (RFC 9110 7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function forwardable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Test-only reverse proxy for the MCP conformance suite (NFR-16): forwards every request to
 * `target` with `authorization: Bearer <token>`, `Host` and `Origin` untouched, and streams
 * the response back (including `text/event-stream`). The token is never logged.
 */
export async function startTokenProxy(opts: { target: string; token: string }): Promise<{ url: string; close(): Promise<void> }> {
  const target = new URL(opts.target);
  const server = createServer((req, res) => {
    const headers = forwardable(req.headers);
    headers.authorization = `Bearer ${opts.token}`;
    const upstream = request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, forwardable(upRes.headers));
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream unreachable');
      }
    });
    // Client gone: stop the upstream request (frees long-lived SSE streams).
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
  };
}
