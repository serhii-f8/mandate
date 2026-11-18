import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Resolver } from '@aiops/adapters';
import type { CredentialHandle } from '@aiops/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendOutcome, WebhookTarget } from './senders.js';
import { createWebhookSender, slackEscape } from './webhook.js';

interface Hit {
  method: string;
  path: string;
  contentType: string | undefined;
  body: string;
}

type Responder = (req: IncomingMessage, res: ServerResponse) => void;

/** A vault fake holding `handles` by credential ref. */
function vaultOf(handles: Record<string, { scheme: string; secret: Record<string, string> }>): { handle(ref: string): Promise<CredentialHandle | undefined> } {
  return {
    handle(ref) {
      const row = handles[ref];
      if (row === undefined) return Promise.resolve(undefined);
      return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
    },
  };
}

describe('webhook sender', () => {
  let server: Server;
  let port: number;
  let hits: Hit[];
  let responder: Responder;
  const outcomes: SendOutcome[] = [];

  beforeEach(async () => {
    hits = [];
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    };
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method ?? '', path: req.url ?? '', contentType: req.headers['content-type'], body });
        responder(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const hookUrl = (): string => `http://127.0.0.1:${String(port)}/hook/SECRETPART`;
  const target = (overrides: Partial<WebhookTarget> = {}): WebhookTarget => ({
    id: 'team-chat',
    urlCredentialRef: 'chat-hook',
    allowedHosts: ['127.0.0.1'],
    allowPrivateNetwork: true,
    ...overrides,
  });
  const senderFor = (url: string, opts: { resolver?: Resolver; timeoutMs?: number } = {}) =>
    createWebhookSender({ vault: vaultOf({ 'chat-hook': { scheme: 'webhook_url', secret: { url } } }), ...opts });
  const record = (o: SendOutcome): SendOutcome => {
    outcomes.push(o);
    return o;
  };

  it('NTF-1 posts {"text"} as application/json and succeeds on 2xx', async () => {
    const outcome = record(await senderFor(hookUrl()).send(target(), 'hi <!channel>'));
    expect(outcome).toEqual({ ok: true });
    expect(hits).toEqual([{ method: 'POST', path: '/hook/SECRETPART', contentType: 'application/json', body: '{"text":"hi &lt;!channel&gt;"}' }]);
  });

  it('NTF-1 slackEscape escapes &, < and >', () => {
    expect(slackEscape('a & b <c> &amp;')).toBe('a &amp; b &lt;c&gt; &amp;amp;');
  });

  it('CONN-5 a host outside allowed_hosts is refused before any connection', async () => {
    const outcome = record(await senderFor(hookUrl()).send(target({ allowedHosts: ['hooks.example.test'] }), 'x'));
    expect(outcome).toEqual({ ok: false, error: 'host_not_allowed' });
    expect(hits).toHaveLength(0);
  });

  it('CONN-5 a private address is refused unless allow_private_network', async () => {
    const literal = record(await senderFor(hookUrl()).send(target({ allowPrivateNetwork: false }), 'x'));
    expect(literal).toEqual({ ok: false, error: 'egress_denied' });

    const resolver: Resolver = () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    const named = record(
      await senderFor(`http://hooks.example.test:${String(port)}/x`, { resolver }).send(
        target({ allowedHosts: ['hooks.example.test'], allowPrivateNetwork: false }),
        'x',
      ),
    );
    expect(named).toEqual({ ok: false, error: 'egress_denied' });
    expect(hits).toHaveLength(0);
  });

  it('CONN-5 a redirect is not followed', async () => {
    responder = (req, res) => {
      if (req.url === '/other') res.writeHead(200).end('ok');
      else res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/other` }).end();
    };
    const outcome = record(await senderFor(hookUrl()).send(target(), 'x'));
    expect(outcome).toEqual({ ok: false, error: 'http_status' });
    expect(hits.filter((h) => h.path === '/other')).toHaveLength(0);
  });

  it('NTF-3 a server that does not answer within the timeout gives timeout', async () => {
    responder = () => {
      // never answers
    };
    const outcome = record(await senderFor(hookUrl(), { timeoutMs: 200 }).send(target(), 'x'));
    expect(outcome).toEqual({ ok: false, error: 'timeout' });
  });

  it('NTF-3 a 500 answer gives http_status', async () => {
    responder = (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('boom SECRETPART');
    };
    const outcome = record(await senderFor(hookUrl()).send(target(), 'x'));
    expect(outcome).toEqual({ ok: false, error: 'http_status' });
  });

  it('NTF-3 a refused connection gives network', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });
    const outcome = record(await senderFor(`http://127.0.0.1:${String(closedPort)}/hook/SECRETPART`).send(target(), 'x'));
    expect(outcome).toEqual({ ok: false, error: 'network' });
  });

  it('SEC-2 a missing credential gives credential_missing; a bearer handle gives credential_unusable', async () => {
    const missing = record(await createWebhookSender({ vault: vaultOf({}) }).send(target(), 'x'));
    expect(missing).toEqual({ ok: false, error: 'credential_missing' });

    const bearer = record(await createWebhookSender({ vault: vaultOf({ 'chat-hook': { scheme: 'bearer', secret: { token: hookUrl() } } }) }).send(target(), 'x'));
    expect(bearer).toEqual({ ok: false, error: 'credential_unusable' });

    const malformed = record(
      await createWebhookSender({ vault: vaultOf({ 'chat-hook': { scheme: 'webhook_url', secret: { url: 'ftp://127.0.0.1/SECRETPART' } } }) }).send(target(), 'x'),
    );
    expect(malformed).toEqual({ ok: false, error: 'credential_unusable' });
    expect(hits).toHaveLength(0);
  });

  it('SEC-3 the URL never appears in an outcome', () => {
    expect(outcomes.length).toBeGreaterThanOrEqual(10);
    for (const o of outcomes) expect(JSON.stringify(o)).not.toContain('SECRETPART');
  });
});
