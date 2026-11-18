import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { assertEgressAllowed, createGuardedLookup, EgressDeniedError, type Resolver } from '@aiops/adapters';
import { parseSecret, type ConnectionSettings } from '@aiops/connector-sdk';
import type { CredentialVault, NotificationError } from '@aiops/core';
import type { SendOutcome, WebhookSender, WebhookTarget } from './senders.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Slack's message escaping: `&`, `<` and `>` become entities, so `<!channel>` and links stay text. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normaliseHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

const fail = (error: NotificationError): SendOutcome => ({ ok: false, error });

/** The webhook URL from the vault, or the failure code. The URL is a secret and never leaves as text (SEC-3). */
async function urlOf(vault: Pick<CredentialVault, 'handle'>, ref: string): Promise<URL | NotificationError> {
  const handle = await vault.handle(ref);
  if (handle === undefined) return 'credential_missing';
  if (handle.scheme !== 'webhook_url') return 'credential_unusable';
  const parsed = parseSecret('webhook_url', await handle.open());
  const url = parsed.ok ? parsed.secret.url : undefined;
  if (url === undefined || !URL.canParse(url)) return 'credential_unusable';
  return new URL(url);
}

/** POSTs `body` once; never follows a redirect and never reads the response body. */
function post(url: URL, body: string, settings: ConnectionSettings, resolver: Resolver | undefined): Promise<SendOutcome> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<SendOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: SendOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      lookup: createGuardedLookup(settings, resolver),
      agent: false,
    });
    const timer = setTimeout(() => {
      settle(fail('timeout'));
      req.destroy();
    }, settings.timeoutMs);
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      settle(status >= 200 && status < 300 ? { ok: true } : fail('http_status'));
    });
    req.on('error', (err) => {
      settle(fail(err instanceof EgressDeniedError ? 'egress_denied' : 'network'));
    });
    req.end(body);
  });
}

/**
 * Webhook delivery (NTF-1): `POST {"text"}` as JSON to the URL held in the vault. The host must be
 * in the target's `allowed_hosts` and then pass the connector egress guard (CONN-5) with a
 * synthesized connection (ADR 0034 j). Failures carry fixed codes only (SEC-3).
 */
export function createWebhookSender(deps: { vault: Pick<CredentialVault, 'handle'>; resolver?: Resolver; timeoutMs?: number }): WebhookSender {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async send(target: WebhookTarget, text: string): Promise<SendOutcome> {
      const url = await urlOf(deps.vault, target.urlCredentialRef);
      if (!(url instanceof URL)) return fail(url);
      const allowed = new Set(target.allowedHosts.map(normaliseHost));
      if (!allowed.has(normaliseHost(url.hostname))) return fail('host_not_allowed');
      const settings: ConnectionSettings = {
        id: `notification:${target.id}`,
        baseUrl: url.href,
        extraHosts: [],
        allowPrivateNetwork: target.allowPrivateNetwork,
        timeoutMs,
        retry: { maxAttempts: 1, initialBackoffMs: 0 },
        maxConcurrency: 1,
      };
      try {
        // `net` skips the lookup for IP literals, so the literal check must run here first.
        assertEgressAllowed(settings, url.hostname);
      } catch (err) {
        if (err instanceof EgressDeniedError) return fail('egress_denied');
        throw err;
      }
      return post(url, JSON.stringify({ text: slackEscape(text) }), settings, deps.resolver);
    },
  };
}
