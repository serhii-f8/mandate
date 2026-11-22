// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Client-credentials token of a service-account client of the bundled realm (AUTH-4), for the
// acceptance scripts.
//
//   service-token.mjs <keycloak-base-url> <client-id> <mcp-resource>
//       reads the client's secret through the admin API, requests a client_credentials token with
//       `resource` and prints only the access token;
//   service-token.mjs --count-secret <keycloak-base-url> <client-id>
//       reads the client's secret the same way, reads text on stdin and prints only how many times
//       the secret occurs in it.
//
// The admin password comes from KEYCLOAK_ADMIN_PASSWORD (exit 2 when unset). The client secret
// stays inside this process: it is never printed, never in argv and never in an error, which names
// only the step and the HTTP status (SEC-3).
const argv = process.argv.slice(2);
const countSecret = argv[0] === '--count-secret';
const [base, clientId, resource] = countSecret ? argv.slice(1) : argv;
if (base === undefined || clientId === undefined || (!countSecret && resource === undefined)) {
  console.error('usage: service-token.mjs <keycloak-base-url> <client-id> <mcp-resource> | service-token.mjs --count-secret <keycloak-base-url> <client-id>');
  process.exit(2);
}
const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!password) {
  console.error('service-token.mjs: KEYCLOAK_ADMIN_PASSWORD is not set');
  process.exit(2);
}

const fail = (step, status) => {
  console.error(`service-token.mjs: ${step} failed${status === undefined ? '' : `: HTTP ${String(status)}`}`);
  process.exit(1);
};
const form = (fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

async function call(step, url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    fail(step);
  }
  if (!response.ok) fail(step, response.status);
  try {
    return await response.json();
  } catch {
    return fail(`${step} (unreadable body)`, response.status);
  }
}

async function clientSecret() {
  const admin = await call('admin token', `${base}/realms/master/protocol/openid-connect/token`, form({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin', password }));
  const auth = { headers: { authorization: `Bearer ${admin.access_token}` } };
  const clients = await call('client lookup', `${base}/admin/realms/mandate/clients?${new URLSearchParams({ clientId, search: 'false' })}`, auth);
  const uuid = Array.isArray(clients) && clients.length === 1 ? clients[0].id : undefined;
  if (typeof uuid !== 'string') fail(`client lookup (${Array.isArray(clients) ? String(clients.length) : 'no'} matches)`);
  const secret = (await call('client secret', `${base}/admin/realms/mandate/clients/${encodeURIComponent(uuid)}/client-secret`, auth)).value;
  if (typeof secret !== 'string' || secret.length === 0) fail('client secret (empty)');
  return secret;
}

const secret = await clientSecret();
if (countSecret) {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  console.log(text.split(secret).length - 1);
} else {
  const tokens = await call(
    'token request',
    `${base}/realms/mandate/protocol/openid-connect/token`,
    form({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, resource }),
  );
  if (typeof tokens.access_token !== 'string') fail('token request (no access_token)');
  console.log(tokens.access_token);
}
