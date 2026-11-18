/**
 * Widget bundles as MCP Apps UI resources over the real MCP transport (MCP-5, UI-6, SEC-1, AUTH-2).
 *
 * The api runs on `approval-config` with `AIOPS_WIDGET_DIR` set to `fixtures/widgets`, two small
 * HTML documents that stand in for the built bundles.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { connectClient, modernRequest, rawPost, startApi, startDatabase, tokenFor, type RunningApi } from './helpers.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));
const WIDGET_DIR = fileURLToPath(new URL('./fixtures/widgets', import.meta.url));
const UI_META = { ui: { csp: {}, prefersBorder: true } };
const MIME = 'text/html;profile=mcp-app';

let postgres: StartedPostgres;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;

beforeAll(async () => {
  const started = await startDatabase();
  postgres = started.postgres;
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-widgets-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  api = await startApi(started.databaseUrl, { issuer, configDir, widgetDir: WIDGET_DIR });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

describe('MCP-5 UI resources over HTTP', () => {
  it('MCP-5 a real client lists and reads both resources', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const { resources } = await client.listResources();
      expect(resources).toEqual([
        { uri: 'ui://aiops/changeset.html', name: 'changeset', title: 'Change-set', mimeType: MIME, _meta: UI_META },
        { uri: 'ui://aiops/approval.html', name: 'approval', title: 'Approval', mimeType: MIME, _meta: UI_META },
      ]);
      for (const file of ['changeset.html', 'approval.html']) {
        const uri = `ui://aiops/${file}`;
        const { contents } = await client.readResource({ uri });
        expect(contents).toEqual([{ uri, mimeType: MIME, text: await readFile(join(WIDGET_DIR, file), 'utf8'), _meta: UI_META }]);
      }
    } finally {
      await client.close();
    }
  });

  it('MCP-5 a legacy-era client lists and reads the resources too', async () => {
    const client = await connectClient({ era: 'legacy', baseUrls: [api.url], token: alice });
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(['ui://aiops/changeset.html', 'ui://aiops/approval.html']);
      const { contents } = await client.readResource({ uri: 'ui://aiops/changeset.html' });
      expect(contents).toEqual([{ uri: 'ui://aiops/changeset.html', mimeType: MIME, text: await readFile(join(WIDGET_DIR, 'changeset.html'), 'utf8'), _meta: UI_META }]);
    } finally {
      await client.close();
    }
  });

  it('MCP-5 an unknown URI rejects with code -32602 and data.uri', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      await expect(client.readResource({ uri: 'ui://aiops/nope.html' })).rejects.toMatchObject({ code: -32602, data: { uri: 'ui://aiops/nope.html' } });
    } finally {
      await client.close();
    }
  });

  it('SEC-1 AUTH-2 resources/list without a bearer token is 401', async () => {
    const { body, headers } = modernRequest('resources/list');
    const response = await rawPost(api.url, body, headers);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).not.toBeNull();
  });
});

describe('MCP-5 tool linkage over HTTP', () => {
  it('MCP-5 tools/list links shop.update_content, shop.retire_content and get_changeset to the change-set widget; ping and cancel_changeset link nothing', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const { tools } = await client.listTools();
      const meta = (name: string) => tools.find((t) => t.name === name)?._meta;
      const linked = { ui: { resourceUri: 'ui://aiops/changeset.html' }, 'ui/resourceUri': 'ui://aiops/changeset.html' };
      for (const name of ['shop.update_content', 'shop.retire_content', 'get_changeset']) expect(meta(name), name).toEqual(linked);
      for (const name of ['ping', 'cancel_changeset']) {
        expect(tools.some((t) => t.name === name), name).toBe(true);
        expect(meta(name), name).toBeUndefined();
      }
    } finally {
      await client.close();
    }
  });
});
