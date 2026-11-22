// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The api's production execution wiring, with Temporal unreachable: no executor or starter
 * override, the real `TemporalExecutor` / `TemporalWorkflowStarter` on a lazy connection
 * (ADR 0029 (g)). Only PostgreSQL runs; nothing listens on the Temporal address.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createOpenApiAdapter } from '@mandate/adapters';
import { ConfigurationHolder, type ApiEnv } from '@mandate/config';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { configurationLoadOptions } from '@mandate/upstream';
import { createApp } from '../../src/app.js';
import { startApiTelemetry } from '../../src/telemetry.js';
import { auditRows, connectClient, freePort, startDatabase, withFreePort, testApiEnv, text } from './helpers.js';

const CHANGESET_CONFIG = fileURLToPath(new URL('./fixtures/changeset-config', import.meta.url));
/** Nothing listens here: connection refused. */
const UNREACHABLE = '127.0.0.1:1';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let configDir: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  configDir = await mkdtemp(join(tmpdir(), 'mandate-temporal-wiring-e2e-'));
  await cp(CHANGESET_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  // The upstream is never called: the call fails at the workflow start.
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', 'http://127.0.0.1:9'));
});

afterAll(async () => {
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

async function load(env: ApiEnv) {
  const adapter = createOpenApiAdapter();
  return { adapter, configuration: await ConfigurationHolder.load(env.configDir, configurationLoadOptions(adapter, env)) };
}

describe('MCP-7 EXE-11 production Temporal wiring while Temporal is down', () => {
  it('MCP-7 the api starts and is ready with Temporal unreachable, a write call answers executor_unavailable, and it shuts down', async () => {
    await withFreePort(async (port) => {
    const env: ApiEnv = { ...testApiEnv(databaseUrl, port, { issuer, configDir }), temporalAddress: UNREACHABLE };
    const { adapter, configuration } = await load(env);
    const app = await createApp({ env, configuration, overrides: { adapter } });
    let closed = false;
    try {
      await app.listen(port, '127.0.0.1');
      const url = `http://127.0.0.1:${String(port)}`;
      expect((await fetch(`${url}/readyz`)).status).toBe(200);

      const token = await issuer.token({ sub: 'alice-id', groups: ['content'], aud: env.mcpResource.href, azp: 'mandate-mcp' });
      let correlationId = '';
      const client = await connectClient({
        era: 'modern',
        baseUrls: [url],
        token,
        onResponse: (r) => {
          correlationId = r.headers.get('x-correlation-id') ?? correlationId;
        },
      });
      let result: unknown;
      try {
        result = await client.callTool({ name: 'shop.update_content', arguments: { brand: 'acme', skus: ['acme-1'], changes: { name: 'New name' } } });
      } finally {
        await client.close();
      }
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(text(result)).toContain('could not be prepared: the execution service is unavailable');
      const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
      expect(rows.map((r) => [r.action, r.details.to ?? null])).toEqual([
        ['policy.decision', null],
        ['changeset.transition', 'preparing'],
        ['changeset.transition', 'failed'],
        ['tool.call', null],
      ]);
      expect(rows.at(-1)?.details).toMatchObject({ errorCode: 'executor_unavailable' });

      await app.close();
      closed = true;
    } finally {
      if (!closed) await app.close();
    }
    });
  }, 120_000);

  it('NFR-11 a tool call is one mcp.request span with a child mcp.tool_call span, both carrying the response correlation ID', async () => {
    await withFreePort(async (port) => {
    const env: ApiEnv = { ...testApiEnv(databaseUrl, port, { issuer, configDir }), temporalAddress: UNREACHABLE };
    const { adapter, configuration } = await load(env);
    const exporter = new InMemorySpanExporter();
    // register: true installs the context manager, so the active span crosses the SDK's node handler.
    const telemetry = startApiTelemetry({ serviceName: 'mandate-api', spanProcessor: new SimpleSpanProcessor(exporter), register: true });
    const app = await createApp({ env, configuration, telemetry, overrides: { adapter } });
    let closed = false;
    try {
      await app.listen(port, '127.0.0.1');
      const token = await issuer.token({ sub: 'alice-id', groups: ['content'], aud: env.mcpResource.href, azp: 'mandate-mcp' });
      const correlationIds: string[] = [];
      const client = await connectClient({
        era: 'modern',
        baseUrls: [`http://127.0.0.1:${String(port)}`],
        token,
        onResponse: (r) => {
          const id = r.headers.get('x-correlation-id');
          if (id !== null) correlationIds.push(id);
        },
      });
      // Only the tools/call request counts: initialize and the rest come before it.
      exporter.reset();
      correlationIds.length = 0;
      try {
        await client.callTool({ name: 'ping', arguments: {} });
      } finally {
        await client.close();
      }
      const spans = exporter.getFinishedSpans();
      const toolCalls = spans.filter((s) => s.name === 'mcp.tool_call');
      expect(toolCalls).toHaveLength(1);
      const toolCall = toolCalls[0];
      if (toolCall === undefined) throw new Error('no mcp.tool_call span');
      const correlationId = toolCall.attributes['mandate.correlation_id'];
      // The tool call's correlation ID is the one a response carried (the client may send more than tools/call).
      expect(correlationIds).toContain(correlationId);
      const requests = spans.filter((s) => s.name === 'mcp.request' && s.attributes['mandate.correlation_id'] === correlationId);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (request === undefined) throw new Error('no mcp.request span');
      // Ended (finished spans only are exported), a server span, the correlation ID its only attribute.
      expect(request.kind).toBe(SpanKind.SERVER);
      expect(request.ended).toBe(true);
      expect(request.attributes).toEqual({ 'mandate.correlation_id': correlationId });
      expect(toolCall.spanContext().traceId).toBe(request.spanContext().traceId);
      expect(toolCall.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
      expect(toolCall.attributes).toMatchObject({ 'mandate.tool': 'ping', 'mandate.correlation_id': correlationId });
      // SEC-3: no attribute of any span carries the bearer token.
      for (const span of spans) {
        for (const value of Object.values(span.attributes)) expect(String(value)).not.toContain(token);
      }

      await app.close();
      closed = true;
    } finally {
      if (!closed) await app.close();
    }
    });
  }, 120_000);

  it('SEC-4 a malformed MANDATE_TEMPORAL_KEYS stops the start, named without the value', async () => {
    const port = await freePort();
    const env: ApiEnv = { ...testApiEnv(databaseUrl, port, { issuer, configDir }), temporalAddress: UNREACHABLE, temporalKeys: 'garbage' };
    const { adapter, configuration } = await load(env);
    const error: unknown = await createApp({ env, configuration, overrides: { adapter } }).then(
      async (app) => {
        await app.close();
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('MANDATE_TEMPORAL_KEYS');
    expect((error as Error).message).not.toContain('garbage');
  });
});
