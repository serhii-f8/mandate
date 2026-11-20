import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CodeAdapter,
  CodeArgs,
  CodeOperation,
  CodeReadOperation,
  CodeWriteOperation,
  ConnectionSettings,
  CredentialSource,
  ReadAdapter,
  ReadOutcome,
  RecordOutcome,
  RecordWriteAdapter,
  ResponseMapping,
  UpstreamMapping,
  WriteFailure,
  WriteRecord,
} from '@aiops/connector-sdk';
import type { FakeUpstream, RecordedRequest } from './fake-upstream.js';

/** One recorded request and the response it got (NFR-17). */
export interface RecordedExchange {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
  readonly response: { readonly status: number; readonly body?: unknown };
}

/** The structural subset of the config `OperationBinding` the helpers run (the MCP variant has no recordings here). */
export type ContractBinding =
  | { readonly kind: 'http'; readonly mapping: UpstreamMapping }
  | { readonly kind: 'code'; readonly name: string; readonly response: ResponseMapping };

const FAKE_TOKEN = 'contract-test-only-token';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** The configuration YAML binding one preset to one connection, for `loadConfigurationSources`. */
export function presetConnectionYaml(input: {
  presetId: string;
  package: string;
  version?: string;
  connectionId: string;
  adapter?: 'openapi' | 'mcp';
  baseUrl: string;
  credentialRef?: string;
  operationPrefix?: string;
  extra?: string;
}): string {
  const adapter = input.adapter ?? 'openapi';
  const entry = [`id: ${input.presetId}`, `package: '${input.package}'`, ...(input.version === undefined ? [] : [`version: '${input.version}'`])];
  const lines = [
    'version: 1',
    'presets:',
    `  - { ${entry.join(', ')} }`,
    'connections:',
    `  - id: ${input.connectionId}`,
    `    adapter: ${adapter}`,
    `    ${adapter === 'mcp' ? 'mcp_url' : 'base_url'}: ${input.baseUrl}`,
    `    credential_ref: ${input.credentialRef ?? `${input.connectionId}-token`}`,
    `    preset: ${input.presetId}`,
    ...(input.operationPrefix === undefined ? [] : [`    operation_prefix: ${input.operationPrefix}`]),
    '    allow_private_network: true',
  ];
  if (input.extra !== undefined && input.extra !== '') lines.push(input.extra.replace(/\n+$/, ''));
  lines.push('');
  return lines.join('\n');
}

function isExchange(value: unknown): value is RecordedExchange {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { request?: { method?: unknown; path?: unknown }; response?: { status?: unknown } };
  return typeof v.request?.method === 'string' && typeof v.request.path === 'string' && typeof v.response?.status === 'number';
}

function matches(exchange: RecordedExchange, req: RecordedRequest): boolean {
  if (exchange.request.method.toUpperCase() !== req.method.toUpperCase()) return false;
  if (!isDeepStrictEqual(Object.fromEntries(req.query), exchange.request.query ?? {})) return false;
  if (exchange.request.body === undefined) return req.body === '';
  try {
    return isDeepStrictEqual(JSON.parse(req.body) as unknown, exchange.request.body);
  } catch {
    return false;
  }
}

/**
 * Routes every exchange of `dir/*.json` (a single exchange or `{ exchanges: [...] }`) on the
 * fake upstream; query and body must match exactly. Requests that match no exchange answer 404
 * and are collected in `unexpected`.
 */
export async function replayRecordings(
  fake: FakeUpstream,
  dir: string,
  options: { basePath?: string } = {},
): Promise<{ readonly unexpected: readonly RecordedRequest[]; assertAllUsed(): void }> {
  const basePath = options.basePath ?? '';
  const exchanges: { file: string; exchange: RecordedExchange }[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown;
    const list: unknown = typeof parsed === "object" && parsed !== null && "exchanges" in parsed ? parsed.exchanges : [parsed];
    if (!Array.isArray(list)) throw new Error(`${name}: exchanges is not a list`);
    for (const item of list as unknown[]) {
      if (!isExchange(item)) throw new Error(`${name}: not a recorded exchange`);
      exchanges.push({ file: name, exchange: item });
    }
  }
  const used = new Set<RecordedExchange>();
  const unexpected: RecordedRequest[] = [];
  const paths = new Set(exchanges.map((e) => `${e.exchange.request.method.toUpperCase()} ${basePath}${e.exchange.request.path}`));
  for (const key of paths) {
    const method = key.slice(0, key.indexOf(' '));
    const path = key.slice(key.indexOf(' ') + 1);
    fake.route(method, path, (req) => {
      const hit = exchanges.find((e) => `${e.exchange.request.method.toUpperCase()} ${basePath}${e.exchange.request.path}` === key && matches(e.exchange, req));
      if (hit === undefined) {
        unexpected.push(req);
        return { status: 404, body: { error: 'no recorded exchange matches' } };
      }
      used.add(hit.exchange);
      return { status: hit.exchange.response.status, body: hit.exchange.response.body };
    });
  }
  for (const method of METHODS) {
    fake.routeMatch(method, /.*/, (req) => {
      unexpected.push(req);
      return { status: 404, body: { error: 'no recorded exchange for this path' } };
    });
  }
  return {
    unexpected,
    assertAllUsed(): void {
      const unused = exchanges.filter((e) => !used.has(e.exchange)).map((e) => `${e.file}: ${e.exchange.request.method} ${e.exchange.request.path}`);
      if (unused.length > 0) throw new Error(`recorded exchanges never requested: ${unused.join('; ')}`);
    },
  };
}

function credentialOr(credential: CredentialSource | undefined): CredentialSource {
  return credential ?? { ref: 'contract-token', scheme: 'bearer', open: () => Promise.resolve({ token: FAKE_TOKEN }) };
}

function codeOperationOf<K extends CodeOperation['kind']>(
  operation: CodeOperation | undefined,
  kind: K,
  name: string,
): Extract<CodeOperation, { kind: K }> {
  if (operation?.kind !== kind) throw new Error(`code operation ${name} is not a ${kind} operation`);
  return operation as Extract<CodeOperation, { kind: K }>; // kind checked on the line above
}

/** Runs one read binding (HTTP or code) through the adapter and returns its outcome. */
export async function contractRead(input: {
  adapter: ReadAdapter & CodeAdapter;
  connection: ConnectionSettings;
  binding: ContractBinding;
  codeOperation?: CodeOperation | undefined;
  args: CodeArgs;
  credential?: CredentialSource | undefined;
}): Promise<ReadOutcome> {
  const credential = credentialOr(input.credential);
  if (input.binding.kind === 'http') {
    return input.adapter.read({ connection: input.connection, mapping: input.binding.mapping, args: input.args, credential });
  }
  const operation: CodeReadOperation = codeOperationOf(input.codeOperation, 'read', input.binding.name);
  return input.adapter.codeRead({
    connection: input.connection,
    name: input.binding.name,
    operation,
    args: input.args,
    response: input.binding.response,
    credential,
  });
}

/** Runs a per-record (HTTP) or code write binding; one outcome per record, or the failure of a code write. */
export async function contractWrite(input: {
  adapter: RecordWriteAdapter & CodeAdapter;
  connection: ConnectionSettings;
  binding: ContractBinding;
  codeOperation?: CodeOperation | undefined;
  records: readonly WriteRecord[];
  args: CodeArgs;
  credential?: CredentialSource | undefined;
}): Promise<readonly RecordOutcome[] | WriteFailure> {
  const credential = credentialOr(input.credential);
  if (input.binding.kind === 'http') {
    const outcomes: RecordOutcome[] = [];
    for (const record of input.records) {
      const sent = await input.adapter.writeRecord({ connection: input.connection, mapping: input.binding.mapping, record, args: input.args, credential });
      outcomes.push(sent.ok ? 'ok' : sent.retriable ? 'retriable' : 'failed');
    }
    return outcomes;
  }
  const operation: CodeWriteOperation = codeOperationOf(input.codeOperation, 'write', input.binding.name);
  const done = await input.adapter.codeWrite({
    connection: input.connection,
    name: input.binding.name,
    operation,
    records: input.records,
    args: input.args,
    credential,
  });
  return done.ok ? done.outcomes : done;
}

/** Fails when no file is found below `dir`, or any file contains one of `secrets` (compared case-insensitively). */
export async function recordingsFreeOf(dir: string, secrets: readonly string[]): Promise<void> {
  const walk = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };
  const files = await walk(dir);
  if (files.length === 0) throw new Error(`no recording files below ${dir}`);
  const forbidden = secrets.filter((x) => x !== '').map((x) => x.toLowerCase());
  for (const file of files) {
    const text = (await readFile(file, 'utf8')).toLowerCase();
    if (forbidden.some((x) => text.includes(x))) throw new Error(`${file} contains a secret`);
  }
}
