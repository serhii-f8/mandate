import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the fake upstream saw it. Header names are lower-case. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent verbatim; anything else is sent as JSON. */
  body?: unknown;
  delayMs?: number;
}

export type FakeHandler = (req: RecordedRequest) => FakeResponse;

export interface FakeUpstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Highest number of requests in flight at the same time so far. */
  readonly maxInFlight: number;
  /** Registers (or replaces) the handler for `METHOD path`; the query string is not part of the path. */
  route(method: string, path: string, handler: FakeHandler): void;
  /** Registers a handler for `method` and every path matching `pattern`; tried after exact routes, in registration order. */
  routeMatch(method: string, pattern: RegExp, handler: FakeHandler): void;
  close(): Promise<void>;
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** An HTTP server on 127.0.0.1 with a random port, for adapter tests. Unrouted requests get 404 JSON. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const routes = new Map<string, FakeHandler>();
  const patterns: { method: string; pattern: RegExp; handler: FakeHandler }[] = [];
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const respond = (res: ServerResponse, r: FakeResponse): void => {
    const headers: Record<string, string> = { ...r.headers };
    let payload = '';
    if (r.body !== undefined) {
      if (typeof r.body === 'string') {
        payload = r.body;
      } else {
        payload = JSON.stringify(r.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    }
    res.writeHead(r.status, headers);
    res.end(payload);
  };

  const server = createServer((req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      inFlight -= 1;
    };
    res.on('finish', finish);
    res.on('close', finish);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://fake.invalid');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: u.pathname,
        query: u.searchParams,
        headers: flattenHeaders(req),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const handler =
        routes.get(`${recorded.method.toUpperCase()} ${recorded.path}`) ??
        patterns.find((p) => p.method === recorded.method.toUpperCase() && p.pattern.test(recorded.path))?.handler;
      let r: FakeResponse;
      try {
        r = handler ? handler(recorded) : { status: 404, body: { error: 'not found' } };
      } catch {
        r = { status: 500, body: { error: 'handler failed' } };
      }
      if (r.delayMs !== undefined && r.delayMs > 0) {
        const timer = setTimeout(() => {
          if (!res.destroyed) respond(res, r);
        }, r.delayMs);
        res.on('close', () => {
          clearTimeout(timer);
        });
      } else {
        respond(res, r);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo; // listen() on a TCP port yields AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    route(method, path, handler) {
      routes.set(`${method.toUpperCase()} ${path}`, handler);
    },
    routeMatch(method, pattern, handler) {
      patterns.push({ method: method.toUpperCase(), pattern, handler });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
