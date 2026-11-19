// Calls the api's REST API for trusted pages like the credential page does (UI-5, SEC-8):
// the session cookie, the CSRF token from GET /api/v1/session and the page's Origin.
// Secrets never come from argv (argv shows in `ps`) and are never printed:
//   AIOPS_PAGE_COOKIE   the `aiops_session=…` cookie from page-login.mjs (environment)
//   stdin               the secret for put-credential (the bearer token, one line)
//
//   page-api.mjs <api-base-url> session                   → {"status":200,"body":{…}}
//   page-api.mjs <api-base-url> put-credential <ref>      → {"status":204}  (body: {"token": stdin})
//   page-api.mjs <api-base-url> test <connection-id>      → {"status":200,"body":<CONN-7 report>}
//   page-api.mjs <api-base-url> approvals [after] | changeset <id> | items <id> [after]
//   page-api.mjs <api-base-url> decide <id> <approve|reject|return> <hash> <count> [comment] | start <id>
//                                                         → {"status":<n>,"body":<json>} (APR-7)
//   page-api.mjs <api-base-url> rollback <id> <hash>      → {"status":<n>,"body":<json>} (EXE-8, UI-4; needs a fresh login)
//   page-api.mjs <api-base-url> export <id> <csv|xlsx> <outfile>
//                                                         → {"status":200,"contentType":…,"disposition":…,"bytes":<n>}, body in <outfile> (CS-8);
//                                                           any other status → {"status":<n>,"body":<json>}
// Prints one JSON line; the response body is printed for every command except put-credential; none of them
// carries a secret. Exit 0 whenever a response arrived (the caller checks the status).

import { writeFile } from 'node:fs/promises';

const [base, command, ...args] = process.argv.slice(2);
const cookie = process.env.AIOPS_PAGE_COOKIE;
const USAGE =
  'usage: page-api.mjs <api-base-url> session | put-credential <ref> | test <connection-id> | approvals [after] | changeset <id> | items <id> [after] | decide <id> <approve|reject|return> <hash> <count> [comment] | start <id> | rollback <id> <hash> | export <id> <csv|xlsx> <outfile>';
// Required and optional argument counts per subcommand.
const ARITY = {
  session: [0, 0],
  'put-credential': [1, 1],
  test: [1, 1],
  approvals: [0, 1],
  changeset: [1, 1],
  items: [1, 2],
  decide: [4, 5],
  start: [1, 1],
  rollback: [2, 2],
  export: [3, 3],
};
const arity = Object.hasOwn(ARITY, command ?? '') ? ARITY[command] : undefined;
const count = args[3] === undefined ? Number.NaN : Number(args[3]);
if (
  base === undefined ||
  arity === undefined ||
  args.length < arity[0] ||
  args.length > arity[1] ||
  (command === 'export' && !['csv', 'xlsx'].includes(args[1])) ||
  (command === 'decide' && (!['approve', 'reject', 'return'].includes(args[1]) || !Number.isInteger(count) || count < 0))
) {
  console.error(USAGE);
  process.exit(2);
}
const name = args[0];
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

const printResponse = async (response) =>
  console.log(JSON.stringify({ status: response.status, body: await response.json().catch(() => undefined) }));
const cursor = (path, after) => (after === undefined ? path : `${path}?after=${encodeURIComponent(after)}`);
const id = name === undefined ? '' : encodeURIComponent(name);

if (command === 'put-credential') {
  const token = await readStdin();
  if (token === '') {
    console.error('page-api.mjs: no secret on stdin');
    process.exit(2);
  }
  const response = await fetch(new URL(`/api/v1/credentials/${id}`, api), {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  // A refusal body holds a fixed error code only; it never echoes the secret.
  const body = await response.json().catch(() => undefined);
  console.log(JSON.stringify({ status: response.status, ...(body === undefined ? {} : { error: body.error }) }));
} else if (command === 'test') {
  await printResponse(await fetch(new URL(`/api/v1/connections/${id}/test`, api), { method: 'POST', headers }));
} else if (command === 'approvals') {
  await printResponse(await fetch(new URL(cursor('/api/v1/approvals', args[0]), api), { headers: { cookie } }));
} else if (command === 'changeset') {
  await printResponse(await fetch(new URL(`/api/v1/changesets/${id}`, api), { headers: { cookie } }));
} else if (command === 'items') {
  await printResponse(await fetch(new URL(cursor(`/api/v1/changesets/${id}/items`, args[1]), api), { headers: { cookie } }));
} else if (command === 'decide') {
  const [, decision, hash, , comment] = args;
  const response = await fetch(new URL(`/api/v1/changesets/${id}/decision`, api), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ decision, hash, count, ...(comment === undefined ? {} : { comment }) }),
  });
  await printResponse(response);
} else if (command === 'rollback') {
  const response = await fetch(new URL(`/api/v1/changesets/${id}/rollback`, api), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ hash: args[1] }),
  });
  await printResponse(response);
} else if (command === 'export') {
  const response = await fetch(new URL(`/api/v1/changesets/${id}/export?format=${args[1]}`, api), { headers: { cookie } });
  if (response.status === 200) {
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(args[2], bytes);
    console.log(
      JSON.stringify({
        status: 200,
        contentType: response.headers.get('content-type'),
        disposition: response.headers.get('content-disposition'),
        bytes: bytes.length,
      }),
    );
  } else {
    await printResponse(response);
  }
} else {
  await printResponse(await fetch(new URL(`/api/v1/changesets/${id}/start`, api), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }));
}
