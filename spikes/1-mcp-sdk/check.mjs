// Spike 1 — scripted client checks against two server instances (:4101, :4102)
// that share one task-state directory. Uses the official client package
// (@modelcontextprotocol/client 2.4.0) and the official Tasks extension
// client (@modelcontextprotocol/ext-tasks 0.2.3).
//
// Every assertion prints one line: PASS <name> / FAIL <name> — <detail>.
// Evidence comes from the wire: a recording fetch wrapper captures every HTTP
// request/response the SDK client and the raw task dispatcher make.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTaskSessionFromClient } from '@modelcontextprotocol/ext-tasks/client';

const A = Number(process.env.PORT_A ?? 4101);
const B = Number(process.env.PORT_B ?? 4102);
const PV = '2026-07-28';
const url = (port) => `http://127.0.0.1:${port}/mcp`;
const CLIENT_INFO = { name: 'spike-1-check', version: '0.0.0' };

let failures = 0;
const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) report(name, true);
    else report(name, false, typeof r === 'string' ? r : JSON.stringify(r));
  } catch (e) {
    report(name, false, `threw: ${e?.constructor?.name}: ${e?.message}`);
  }
}
const info = (msg) => console.log(`INFO ${msg}`);

// ---- wire recorder -----------------------------------------------------------
const wire = []; // { port, method, reqHeaders, bodyMeta, status, resHeaders, json }
function recordingFetch({ rotate } = {}) {
  let n = 0;
  return async (input, init = {}) => {
    const target = new URL(input instanceof URL || typeof input === 'string' ? input : input.url);
    if (rotate) {
      target.port = String(rotate[n % rotate.length]);
      n++;
    }
    const reqHeaders = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let body;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {}
    const res = await fetch(target, init);
    const entry = {
      port: Number(target.port),
      method: body?.method,
      taskId: body?.params?.taskId,
      reqHeaders,
      bodyMeta: body?.params?._meta,
      status: res.status,
      resHeaders: Object.fromEntries(res.headers.entries()),
    };
    Object.defineProperty(entry, 'res', { value: res, enumerable: false });
    wire.push(entry);
    return res;
  };
}

async function connect(token, port, { rotate } = {}) {
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: { pin: PV } } });
  const transport = new StreamableHTTPClientTransport(new URL(url(port)), {
    authProvider: { token: async () => token },
    fetch: recordingFetch({ rotate }),
  });
  await client.connect(transport);
  return client;
}

// Raw dispatcher for Tasks V2 traffic, as required by ext-tasks 0.2.3
// (see README: "a 2026-07-28 Tasks server additionally requires rawDispatch
// and v2RequestFraming"). It speaks Streamable HTTP per the spec headers.
function rawDispatchFor(token, port) {
  const f = recordingFetch();
  let id = 1000;
  return async (request, options = {}) => {
    const msg = { jsonrpc: '2.0', id: id++, ...request };
    const p = msg.params ?? {};
    const name = p.name ?? p.uri ?? p.taskId;
    // Headers object so that context headers supplied by ext-tasks replace
    // (not duplicate) ours case-insensitively.
    const headers = new Headers(options.context?.headers ?? {});
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('authorization', `Bearer ${token}`);
    headers.set('mcp-protocol-version', PV);
    headers.set('mcp-method', msg.method);
    if (name !== undefined) headers.set('mcp-name', String(name));
    const res = await f(url(port), { method: 'POST', headers, body: JSON.stringify(msg), signal: options.signal });
    const json = await res.json();
    const entry = wire.findLast((w) => w.res === res);
    entry.json = json;
    if (json.error) return { kind: 'error', error: json.error };
    return { kind: 'result', result: json.result };
  };
}

function taskSession(client, token, port) {
  return createTaskSessionFromClient(client, {
    // One logical endpoint served by two instances: the same endpointId on
    // both, so a reference serialized on A can be resumed on B.
    endpointId: 'spike-1-mcp',
    rawDispatch: rawDispatchFor(token, port),
    v2RequestFraming: { protocolVersion: PV, clientInfo: CLIENT_INFO, clientCapabilities: {} },
  });
}

const sortedNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ============================================================================
const alice = await connect('alice-token', A);
const bob = await connect('bob-token', A);

await check('protocol-version-2026-07-28', async () => {
  await alice.listTools();
  const negotiated = alice.getNegotiatedProtocolVersion();
  const era = alice.getProtocolEra();
  const posts = wire.filter((w) => w.method);
  const badHeader = posts.filter((w) => w.reqHeaders['mcp-protocol-version'] !== PV);
  const badMeta = posts.filter((w) => w.bodyMeta?.['io.modelcontextprotocol/protocolVersion'] !== PV);
  const methods = [...new Set(posts.map((w) => w.method))];
  info(`negotiated=${negotiated} era=${era} wire methods so far=${methods.join(',')}`);
  if (negotiated !== PV || era !== 'modern') return `negotiated=${negotiated} era=${era}`;
  if (badHeader.length) return `${badHeader.length} requests without MCP-Protocol-Version: ${PV}`;
  if (badMeta.length) return `${badMeta.length} requests without _meta protocolVersion ${PV}`;
  if (methods.includes('initialize')) return 'client sent initialize';
  return true;
});

await check('alice-tool-list', async () => {
  const names = await sortedNames(alice);
  return sameList(names, ['search_products', 'slow_export']) || `got ${names}`;
});

await check('bob-tool-list', async () => {
  const names = await sortedNames(bob);
  return sameList(names, ['list_orders']) || `got ${names}`;
});

await check('bob-cannot-call-alice-tool', async () => {
  // Positive control first: bob's own tool works.
  const own = await bob.callTool({ name: 'list_orders', arguments: {} });
  if (own.isError) return `bob's own tool failed: ${JSON.stringify(own)}`;
  const outcomes = [];
  for (const [name, args] of [['search_products', { query: 'x' }], ['slow_export', { format: 'csv' }]]) {
    try {
      const r = await bob.callTool({ name, arguments: args });
      if (!r.isError) return `bob called ${name} successfully: ${JSON.stringify(r).slice(0, 200)}`;
      outcomes.push(`${name}: isError ${r.content?.[0]?.text}`);
    } catch (e) {
      outcomes.push(`${name}: ${e.code ?? ''} ${e.message}`);
    }
  }
  info(`bob -> alice tools rejected: ${outcomes.join(' | ')}`);
  return true;
});

await check('unauthenticated-401', async () => {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PV,
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const statuses = [];
  for (const auth of [undefined, 'Bearer mallory-token', 'Basic YWxpY2U6eA==']) {
    const res = await fetch(url(A), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PV,
        'mcp-method': 'tools/list',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });
    statuses.push(`${auth ?? 'none'}=>${res.status} ${res.headers.get('www-authenticate') ?? ''}`);
    if (res.status !== 401) return `expected 401, got ${statuses.join('; ')}`;
  }
  // The SDK client with an unknown token must also fail to connect.
  try {
    await connect('mallory-token', A);
    return 'client connected with an unknown token';
  } catch (e) {
    statuses.push(`sdk-client connect: ${e.constructor.name}`);
  }
  info(`unauthenticated: ${statuses.join(' | ')}`);
  return true;
});

let startedTaskId;
await check('task-completes', async () => {
  const session = taskSession(alice, 'alice-token', A);
  try {
    const before = wire.length;
    const execution = await session.callTool('slow_export', { format: 'csv' });
    if (execution.kind !== 'task') return `expected a task handle, got kind=${execution.kind}`;
    const taskId = execution.handle.taskId;
    const statuses = [];
    const { outcome } = await execution.settle({ onEvent: (ev) => ev.type === 'task' && statuses.push(ev.task.status) });
    const polls = wire.slice(before).filter((w) => w.method === 'tasks/get');
    const call = wire.slice(before).find((w) => w.method === 'tools/call');
    info(`task ${taskId}: tools/call resultType=${call?.json?.result?.resultType}, ${polls.length} tasks/get polls with statuses [${polls.map((p) => p.json?.result?.status ?? JSON.stringify(p.json?.error))}], session events [${statuses}], outcome=${outcome.status}, later methods=${wire.slice(before).map((w) => w.method)}`);
    if (call?.json?.result?.resultType !== 'task') return 'tools/call did not return resultType "task" on the wire';
    if (polls.length < 1) return 'no tasks/get poll on the wire';
    if (!polls.some((p) => p.json?.result?.status === 'working')) return 'never observed status working (not a long-running call?)';
    if (outcome.status !== 'completed') return `outcome ${outcome.status}: ${outcome.error?.message} ${JSON.stringify(outcome.error?.data ?? '')} cause=${outcome.error?.cause?.message ?? ''}`;
    if (outcome.result?.structuredContent?.rows !== 42) return `unexpected result ${JSON.stringify(outcome.result)}`;
    return true;
  } finally {
    await session.close();
  }
});

await check('bob-cannot-poll-alice-task', async () => {
  // Negative control for task auth binding: start a task as alice, poll as bob.
  const s = taskSession(alice, 'alice-token', A);
  const execution = await s.callTool('slow_export', { format: 'json' });
  startedTaskId = execution.handle?.taskId;
  await execution.handoff(() => {});
  await execution.result().catch(() => {});
  await s.close();
  const request = {
    method: 'tasks/get',
    params: {
      taskId: startedTaskId,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PV,
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
        'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      },
    },
  };
  // Positive control on the SAME instance and task ID: the owner can read it. Without this,
  // "task not found" for bob could simply mean the task is unknown to instance B.
  const aliceOnB = await rawDispatchFor('alice-token', B)(request);
  info(`alice tasks/get on her own task via instance B: ${JSON.stringify(aliceOnB).slice(0, 160)}`);
  if (aliceOnB.kind === 'error') return `owner could not read her own task on instance B: ${JSON.stringify(aliceOnB)}`;
  const r = await rawDispatchFor('bob-token', B)(request);
  info(`bob tasks/get on alice's task: ${JSON.stringify(r)}`);
  return (r.kind === 'error' && r.error.code === -32602) || `bob got ${JSON.stringify(r)}`;
});

await check('task-survives-instance-switch', async () => {
  // Start on A ...
  const sA = taskSession(alice, 'alice-token', A);
  const execution = await sA.callTool('slow_export', { format: 'csv' });
  if (execution.kind !== 'task') return `expected task, got ${execution.kind}`;
  const taskId = execution.handle.taskId;
  const startedOn = wire.filter((w) => w.method === 'tools/call').at(-1);
  // Release A's ownership without cancelling: persist a reference, then let
  // the detached execution settle locally before closing the session (an
  // execution still tracked as active is cancelled by session.close()).
  let reference;
  await execution.handoff((ref) => {
    reference = ref;
  });
  await execution.result().catch(() => {});
  await sA.close();
  // ... resume and poll on B with a separate client that never talked to A.
  const aliceB = await connect('alice-token', B);
  const sB = taskSession(aliceB, 'alice-token', B);
  try {
    const before = wire.length;
    const resumed = await sB.resumeTask(reference);
    const { outcome } = await resumed.settle();
    const polls = wire.slice(before).filter((w) => w.method === 'tasks/get');
    const cancels = wire.filter((w) => w.method === 'tasks/cancel' && w.taskId === taskId);
    if (cancels.length) return `client sent tasks/cancel for the task ${cancels.length}x during the switch`;
    const servedBy = [...new Set(polls.map((p) => p.resHeaders['x-spike-instance']))];
    const statuses = polls.map((p) => p.json?.result?.status);
    info(`task ${taskId}: started on ${startedOn.resHeaders['x-spike-instance']}, polled ${polls.length}x on ${servedBy}, statuses=${[...new Set(statuses)].join('>')}, finished by "${polls.at(-1)?.json?.result?.statusMessage}"`);
    if (startedOn.port !== A) return `task was not started on ${A}`;
    if (!sameList(servedBy, [`instance-${B}`])) return `polls served by ${servedBy}`;
    if (!statuses.includes('working')) return 'B never saw the task in working state (task finished before switch?)';
    if (outcome.status !== 'completed') return `outcome ${outcome.status}`;
    return outcome.result?.structuredContent?.rows === 42 || `result ${JSON.stringify(outcome.result)}`;
  } finally {
    await sB.close();
    await aliceB.close();
  }
});

await check('list-on-either-instance', async () => {
  // One client, one server/discover against A only; afterwards every request
  // is sent alternately to B and A. No handshake ever reaches B.
  const before = wire.length;
  const c = await connect('bob-token', A, { rotate: [A, B] });
  // rotate: the connect probe went to A (index 0); the next request goes to B.
  const lists = [];
  for (let i = 0; i < 6; i++) lists.push(await sortedNames(c));
  const mine = wire.slice(before);
  const discoverPorts = mine.filter((w) => w.method === 'server/discover').map((w) => w.port);
  const listCalls = mine.filter((w) => w.method === 'tools/list');
  const served = listCalls.map((w) => w.resHeaders['x-spike-instance']);
  info(`server/discover sent to ${discoverPorts}; tools/list served by ${served.join(',')}`);
  await c.close();
  if (!sameList(discoverPorts, [A])) return `discover went to ${discoverPorts}`;
  if (listCalls.length !== 6) return `expected 6 tools/list on the wire (no client cache), got ${listCalls.length}`;
  if (!served.includes(`instance-${A}`) || !served.includes(`instance-${B}`)) return `not alternating: ${served}`;
  if (listCalls.some((w) => w.status !== 200)) return `non-200: ${listCalls.map((w) => w.status)}`;
  return lists.every((l) => sameList(l, ['list_orders'])) || `lists differ: ${JSON.stringify(lists)}`;
});

await check('no-session-header', async () => {
  const sessionReq = wire.filter((w) => 'mcp-session-id' in w.reqHeaders);
  const sessionRes = wire.filter((w) => 'mcp-session-id' in w.resHeaders);
  const inits = wire.filter((w) => w.method === 'initialize' || w.method === 'notifications/initialized');
  info(`inspected ${wire.length} HTTP exchanges; methods: ${[...new Set(wire.map((w) => w.method))].join(',')}`);
  if (sessionRes.length) return `${sessionRes.length} responses carried Mcp-Session-Id`;
  if (sessionReq.length) return `${sessionReq.length} requests carried Mcp-Session-Id`;
  if (inits.length) return `${inits.length} initialize exchanges`;
  return true;
});

// Informational: does the plain SDK client handle a Tasks V2 result itself?
try {
  const plain = new Client(CLIENT_INFO, {
    versionNegotiation: { mode: { pin: PV } },
    capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
  });
  await plain.connect(new StreamableHTTPClientTransport(new URL(url(A)), { authProvider: { token: async () => 'alice-token' } }));
  const r = await plain.callTool({ name: 'slow_export', arguments: { format: 'csv' } });
  info(`plain Client.callTool(slow_export) returned: ${JSON.stringify(r).slice(0, 200)}`);
  await plain.close();
} catch (e) {
  info(`plain Client.callTool(slow_export) without ext-tasks: ${e.constructor.name} ${e.code ?? ''}: ${e.message}`);
}

await alice.close();
await bob.close();
console.log(`${results.length - failures}/${results.length} assertions passed`);
process.exit(failures ? 1 : 0);
