// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Logs a development user in to the api's trusted pages like a browser (AUTH-5):
// GET /auth/login → Keycloak login form (posted) → /auth/callback → the return path.
// Redirects are followed by hand with one cookie jar per host name (ports share cookies, as
// in browsers), so the api's `aiops_login` cookie travels from /auth/login to /auth/callback.
// Prints the session cookie, ready for a Cookie header: `aiops_session=…`.
// Usage: node tooling/acceptance/page-login.mjs <api-base-url> <username> <password> [return-to]
// The password is a visibly fake development default; never pass a real one on argv.

const [base, username, password, returnTo = '/app/credentials'] = process.argv.slice(2);
if (password === undefined) {
  console.error('usage: page-login.mjs <api-base-url> <username> <password> [return-to]');
  process.exit(2);
}
const api = new URL(base);
const jar = new Map(); // host name → Map(cookie name → value)

function cookieHeader(url) {
  return [...(jar.get(url.hostname) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; ');
}

function store(url, response) {
  const cookies = jar.get(url.hostname) ?? new Map();
  jar.set(url.hostname, cookies);
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = cookie.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) cookies.delete(name);
    else cookies.set(name, value);
  }
}

async function request(url, form) {
  const response = await fetch(url, {
    method: form === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(url), ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
    ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
  });
  store(url, response);
  return response;
}

const formAction = (page) => page.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');

let url = new URL(`/auth/login?${new URLSearchParams({ return_to: returnTo })}`, api);
let response = await request(url);
let formShown = false;
let landedAt;
for (let i = 0; i < 20 && landedAt === undefined; i++) {
  if (response.status >= 300 && response.status < 400) {
    const next = new URL(response.headers.get('location') ?? '', url);
    if (next.origin === api.origin && !next.pathname.startsWith('/auth/')) {
      landedAt = next;
      break;
    }
    url = next;
    response = await request(url);
    continue;
  }
  const page = await response.text();
  const action = response.status === 200 && !formShown ? formAction(page) : undefined;
  if (action === undefined) throw new Error(`page login stopped at ${url.pathname} with HTTP ${response.status}`);
  formShown = true;
  url = new URL(action, url);
  response = await request(url, { username, password, credentialId: '' });
}
if (landedAt === undefined) throw new Error('page login: too many redirects');
const session = jar.get(api.hostname)?.get('aiops_session');
if (session === undefined) throw new Error('page login: no session cookie was set');
console.log(`aiops_session=${session}`);
