#!/usr/bin/env node
// @ts-check
/**
 * Bundled-realm settings that a realm import cannot toggle (AUTH-8, ADR 0014),
 * applied through the Keycloak Admin REST API. Idempotent: it owns the realm's
 * client profiles and policies and replaces them on every run.
 *
 *   - PKCE S256 for every client, however it was registered (pkce-enforcer, any-client)
 *   - Client ID Metadata Documents from trusted domains (client-id-metadata-document)
 *   - anonymous Dynamic Client Registration off by default; AIOPS_DCR=on admits
 *     registrations whose redirect URIs are on AIOPS_DCR_REDIRECT_HOSTS
 *   - one confidential client-credentials client per AIOPS_KEYCLOAK_SERVICE_ACCOUNTS
 *     name (AUTH-4); created once, updated in place, its secret left alone
 *
 * Environment (defaults in brackets):
 *   KEYCLOAK_URL [http://localhost:8080], KEYCLOAK_REALM [aiops],
 *   KEYCLOAK_ADMIN_USER [admin], KEYCLOAK_ADMIN_PASSWORD (required),
 *   AIOPS_MCP_RESOURCE (required), AIOPS_CIMD_CLIENT_DOMAINS [claude.ai],
 *   AIOPS_CIMD_EXTRA_DOMAINS [localhost,127.0.0.1], AIOPS_DCR [off],
 *   AIOPS_DCR_REDIRECT_HOSTS [claude.ai,chatgpt.com,localhost,127.0.0.1],
 *   AIOPS_CIMD_ALLOW_HTTP [false] (tests only), AIOPS_KEYCLOAK_SERVICE_ACCOUNTS [],
 *   BOOTSTRAP_WAIT_SECONDS [180].
 * Prints one summary line; exits non-zero on any failed call. Never prints secrets.
 */

const env = process.env;
const KEYCLOAK_URL = (env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const REALM = env.KEYCLOAK_REALM ?? 'aiops';
const list = (/** @type {string | undefined} */ value, /** @type {string} */ fallback) =>
  (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

function required(/** @type {string} */ name) {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the realm is served, then returns an admin access token. */
async function adminToken() {
  const deadline = Date.now() + Number(env.BOOTSTRAP_WAIT_SECONDS ?? '180') * 1000;
  const password = required('KEYCLOAK_ADMIN_PASSWORD');
  let last = 'not reached';
  while (Date.now() < deadline) {
    try {
      const realm = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration`);
      if (realm.ok) {
        const response = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
          method: 'POST',
          body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN_USER ?? 'admin', password }),
        });
        if (response.ok) return /** @type {{ access_token: string }} */ (await response.json()).access_token;
        last = `admin token HTTP ${String(response.status)}`;
      } else {
        last = `realm HTTP ${String(realm.status)}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  throw new Error(`Keycloak not ready: ${last}`);
}

/**
 * @param {string} token
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function admin(token, method, path, body) {
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${String(response.status)}`);
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * Creates or updates a confidential client that only has the client-credentials grant (AUTH-4).
 * The body never carries `secret`, so an update keeps the secret Keycloak generated on create.
 * @param {string} token
 * @param {string} clientId
 */
async function ensureServiceClient(token, clientId) {
  const representation = {
    clientId,
    protocol: 'openid-connect',
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
  };
  const found = /** @type {{ id: string }[]} */ (
    await admin(token, 'GET', `/clients?${new URLSearchParams({ clientId, search: 'false' }).toString()}`)
  );
  if (found.length > 1) throw new Error(`more than one client ${clientId}`);
  const existing = found[0];
  if (existing === undefined) await admin(token, 'POST', '/clients', representation);
  else await admin(token, 'PUT', `/clients/${encodeURIComponent(existing.id)}`, representation);
}

async function main() {
  const resource = required('AIOPS_MCP_RESOURCE');
  const clientDomains = list(env.AIOPS_CIMD_CLIENT_DOMAINS, 'claude.ai');
  const extraDomains = list(env.AIOPS_CIMD_EXTRA_DOMAINS, 'localhost,127.0.0.1');
  const allowHttp = env.AIOPS_CIMD_ALLOW_HTTP === 'true';
  const dcr = (env.AIOPS_DCR ?? 'off').toLowerCase();
  if (dcr !== 'on' && dcr !== 'off') throw new Error('AIOPS_DCR must be on or off');
  const dcrHosts = list(env.AIOPS_DCR_REDIRECT_HOSTS, 'claude.ai,chatgpt.com,localhost,127.0.0.1');
  const serviceAccounts = [...new Set(list(env.AIOPS_KEYCLOAK_SERVICE_ACCOUNTS, ''))];

  const token = await adminToken();

  await admin(token, 'PUT', '/client-policies/profiles', {
    profiles: [
      {
        name: 'aiops-pkce',
        description: 'PKCE with S256 for every client (AUTH-8)',
        executors: [{ executor: 'pkce-enforcer', configuration: { 'auto-configure': true } }],
      },
      {
        name: 'aiops-cimd',
        description: 'Accept Client ID Metadata Documents from trusted domains (ADR 0004)',
        executors: [
          {
            executor: 'client-id-metadata-document',
            configuration: {
              'cimd-allow-http-scheme': allowHttp,
              'cimd-allow-permitted-domains': [...new Set([...clientDomains, ...extraDomains])],
              // Off: loopback redirect URIs (Claude Code) are not on the client_id domain.
              'cimd-restrict-same-domain': false,
              'only-allow-confidential-client': false,
              // On: Claude's document lists a grant only confidential clients may use.
              'accept-public-client-with-confidential-client-only-grant': true,
              'cimd-resource-indicator-allow-list': [resource],
            },
          },
        ],
      },
    ],
  });
  await admin(token, 'PUT', '/client-policies/policies', {
    policies: [
      {
        name: 'aiops-pkce-all',
        description: 'Every client must use PKCE S256',
        enabled: true,
        conditions: [{ condition: 'any-client', configuration: {} }],
        profiles: ['aiops-pkce'],
      },
      {
        name: 'aiops-cimd',
        description: 'URL client IDs on a trusted domain are Client ID Metadata Documents',
        enabled: true,
        conditions: [
          {
            condition: 'client-id-uri',
            configuration: { 'client-id-uri-scheme': allowHttp ? ['https', 'http'] : ['https'], 'client-id-uri-allow-permitted-domains': clientDomains },
          },
        ],
        profiles: ['aiops-cimd'],
      },
    ],
  });

  const components = /** @type {{ id: string, providerId: string, subType: string, config: Record<string, string[]> }[]} */ (
    await admin(token, 'GET', '/components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy')
  );
  const trustedHosts = components.find((c) => c.providerId === 'trusted-hosts' && c.subType === 'anonymous');
  if (trustedHosts === undefined) throw new Error('anonymous Trusted Hosts policy not found');
  // "off" is Keycloak's shipped configuration: no trusted hosts, so every anonymous registration is refused.
  trustedHosts.config =
    dcr === 'on'
      ? { 'trusted-hosts': dcrHosts, 'host-sending-registration-request-must-match': ['false'], 'client-uris-must-match': ['true'] }
      : { 'host-sending-registration-request-must-match': ['true'], 'client-uris-must-match': ['true'] };
  await admin(token, 'PUT', `/components/${trustedHosts.id}`, trustedHosts);

  for (const clientId of serviceAccounts) await ensureServiceClient(token, clientId);

  console.log(`keycloak bootstrap done: realm=${REALM} pkce=on cimd=on dcr=${dcr} service_accounts=${String(serviceAccounts.length)}`);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(`keycloak bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
