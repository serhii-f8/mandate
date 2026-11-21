// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Logs a development user in through the real authorization-code + PKCE (S256) flow
// of the bundled realm and prints the access token. The login form is posted like a
// browser would; the final redirect to the loopback callback is read, never followed.
// Usage: node tooling/acceptance/login.mjs <keycloak-base-url> <username> <password> <mcp-resource>
import { createHash, randomBytes } from 'node:crypto';

const [base, username, password, resource] = process.argv.slice(2);
if (resource === undefined) {
  console.error('usage: login.mjs <keycloak-base-url> <username> <password> <mcp-resource>');
  process.exit(2);
}
const CLIENT = 'aiops-mcp';
const REDIRECT = 'http://localhost:33418/callback';
const oidc = `${base}/realms/aiops/protocol/openid-connect`;
const origin = new URL(base).origin;
const cookies = new Map();
const b64url = (b) => b.toString('base64url');

async function request(url, form) {
  const response = await fetch(url, {
    method: form ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  for (const c of response.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return response;
}

async function go(url, form) {
  let current = url;
  let response = await request(current, form);
  for (let i = 0; i < 10 && response.status >= 300 && response.status < 400; i++) {
    const location = new URL(response.headers.get('location'), current);
    if (location.origin !== origin) return { redirect: location };
    current = location.toString();
    response = await request(current);
  }
  return { page: await response.text(), url: current, status: response.status };
}

const verifier = b64url(randomBytes(32));
const state = b64url(randomBytes(16));
const params = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT,
  redirect_uri: REDIRECT,
  scope: 'openid',
  state,
  code_challenge: b64url(createHash('sha256').update(verifier).digest()),
  code_challenge_method: 'S256',
  resource,
});
let step = await go(`${oidc}/auth?${params}`);
if (step.page) {
  const action = step.page.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');
  if (!action) throw new Error(`no login form (HTTP ${step.status})`);
  step = await go(new URL(action, step.url).toString(), { username, password, credentialId: '' });
}
if (!step.redirect) throw new Error(`login failed (HTTP ${step.status})`);
const q = step.redirect.searchParams;
if (q.get('error')) throw new Error(`authorization error: ${q.get('error')}`);
if (q.get('state') !== state) throw new Error('state mismatch');
const response = await fetch(`${oidc}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier, resource }),
});
const tokens = await response.json();
if (!response.ok) throw new Error(`token request failed: HTTP ${response.status} ${tokens.error ?? ''}`);
console.log(tokens.access_token);
