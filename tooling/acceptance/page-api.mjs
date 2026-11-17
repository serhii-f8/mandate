// Calls the api's REST API for trusted pages like the credential page does (UI-5, SEC-8):
// the session cookie, the CSRF token from GET /api/v1/session and the page's Origin.
// Secrets never come from argv (argv shows in `ps`) and are never printed:
//   AIOPS_PAGE_COOKIE   the `aiops_session=…` cookie from page-login.mjs (environment)
//   stdin               the secret for put-credential (the bearer token, one line)
//
//   page-api.mjs <api-base-url> session                   → {"status":200,"body":{…}}
//   page-api.mjs <api-base-url> put-credential <ref>      → {"status":204}  (body: {"token": stdin})
//   page-api.mjs <api-base-url> test <connection-id>      → {"status":200,"body":<CONN-7 report>}
// Prints one JSON line; the response body is printed only for session and test, which never
// carry a secret. Exit 0 whenever a response arrived (the caller checks the status).

const [base, command, name] = process.argv.slice(2);
const cookie = process.env.AIOPS_PAGE_COOKIE;
if (base === undefined || !['session', 'put-credential', 'test'].includes(command) || (command !== 'session' && name === undefined)) {
  console.error('usage: page-api.mjs <api-base-url> session | put-credential <ref> | test <connection-id>');
  process.exit(2);
}
if (cookie === undefined || cookie === '') {
  console.error('page-api.mjs: set AIOPS_PAGE_COOKIE');
  process.exit(2);
}
const api = new URL(base);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const session = await fetch(new URL('/api/v1/session', api), { headers: { cookie } });
const sessionBody = await session.json().catch(() => ({}));
if (command === 'session') {
  console.log(JSON.stringify({ status: session.status, body: sessionBody }));
  process.exit(0);
}
if (!session.ok || typeof sessionBody.csrfToken !== 'string') {
  console.log(JSON.stringify({ status: session.status, step: 'session' }));
  process.exit(0);
}
const headers = { cookie, origin: api.origin, 'x-csrf-token': sessionBody.csrfToken };

if (command === 'put-credential') {
  const token = await readStdin();
  if (token === '') {
    console.error('page-api.mjs: no secret on stdin');
    process.exit(2);
  }
  const response = await fetch(new URL(`/api/v1/credentials/${encodeURIComponent(name)}`, api), {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  // A refusal body holds a fixed error code only; it never echoes the secret.
  const body = await response.json().catch(() => undefined);
  console.log(JSON.stringify({ status: response.status, ...(body === undefined ? {} : { error: body.error }) }));
} else {
  const response = await fetch(new URL(`/api/v1/connections/${encodeURIComponent(name)}/test`, api), { method: 'POST', headers });
  console.log(JSON.stringify({ status: response.status, body: await response.json().catch(() => undefined) }));
}
