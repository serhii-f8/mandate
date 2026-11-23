// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import type { Caller } from '@mandate/core';
import { InMemoryFileStore } from '@mandate/testing';
import { createListStagedFilesTool, LIST_STAGED_FILES_TOOL } from './files-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';

const SOURCES = {
  'connections.yaml': JSON.stringify({ version: 1, connections: [{ id: 'shop', adapter: 'openapi', base_url: 'https://shop.example.test/rest' }] }),
  'operations.yaml': JSON.stringify({
    version: 1,
    operations: [
      {
        id: 'shop.upload',
        connection: 'shop',
        risk: 'write_opaque',
        description: 'Upload an image.',
        upstream: { method: 'POST', path: '/V1/media' },
        input_schema: { type: 'object', properties: { image: { type: 'string', format: 'uuid' } }, required: ['image'] },
        files: [{ at: '/image', send: 'base64', media_types: ['image/png'] }],
      },
      { id: 'shop.note', connection: 'shop', risk: 'write_opaque', description: 'Post a note.', upstream: { method: 'POST', path: '/V1/notes' }, input_schema: { type: 'object', properties: {} } },
    ],
  }),
  'roles.yaml': JSON.stringify({
    version: 1,
    roles: [
      { id: 'editor', grants: [{ operation: 'shop.upload' }], approval: { required: 'never' } },
      { id: 'noter', grants: [{ operation: 'shop.note' }], approval: { required: 'never' } },
    ],
    role_mapping: [
      { group: 'editors', roles: ['editor'] },
      { group: 'noters', roles: ['noter'] },
    ],
  }),
};

async function configuration(): Promise<LoadedConfiguration> {
  const result = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.configuration;
}

const ALICE: Caller = { subject: 'alice', groups: ['editors'], clientId: 'mandate-mcp' };
const NOTER: Caller = { subject: 'noter', groups: ['noters'] };
const PUBLIC = new URL('https://mandate.example.test/');
const NOW = new Date('2026-11-23T10:00:00.000Z');
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_BOB = '33333333-3333-4333-8333-333333333333';
const BOB_NAME = 'bobs-secret-plan.png';
const BOB_HASH = `sha256:${'b'.repeat(64)}`;

async function stage(store: InMemoryFileStore, owner: string, id: string, name: string, sha: string, createdAt: Date): Promise<void> {
  const staged = await store.stage(
    { id, owner, name, mediaType: 'image/png', content: new Uint8Array([1, 2, 3]), sha256: sha, preview: 'image', createdAt, quota: { count: 50, bytes: 1_000_000 } },
    { id: `e-${id}`, actor: owner, action: 'file.staged', outcome: 'ok', correlationId: 'c', details: {} },
  );
  if (!staged.ok) throw new Error('quota');
}

function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

async function setup() {
  const store = new InMemoryFileStore();
  await stage(store, 'alice', ID_A, 'a.png', `sha256:${'a'.repeat(64)}`, new Date(NOW.getTime() - 1000));
  await stage(store, 'alice', ID_B, 'b (1).png', `sha256:${'c'.repeat(64)}`, NOW);
  await stage(store, 'bob', ID_BOB, BOB_NAME, BOB_HASH, NOW);
  const config = await configuration();
  const tool = createListStagedFilesTool({ files: store, publicUrl: PUBLIC });
  const run = async (caller: Caller): Promise<CallToolResult> =>
    plain(
      await tool.handler(
        {},
        { caller, snapshot: { configuration: config } as never, correlationId: 'corr', tasks: false, report: () => undefined },
      ),
    );
  return { tool, config, run };
}

describe('MCP-11 list_staged_files', () => {
  it('MCP-11 is named list_staged_files, takes no arguments and is read-only', async () => {
    const { tool } = await setup();
    expect(tool.name).toBe(LIST_STAGED_FILES_TOOL);
    expect(tool.name).toBe('list_staged_files');
    expect(tool.readOnlyHint).toBe(true);
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool.validate({}).ok).toBe(true);
    expect(tool.validate({ x: 1 }).ok).toBe(false);
  });

  it('MCP-11 CS-10 is visible to a caller whose role may stage files, to no one else', async () => {
    const { tool, config } = await setup();
    expect(tool.visibleTo?.(ALICE, config)).toBe(true);
    expect(tool.visibleTo?.(NOTER, config)).toBe(false);
    expect(tool.visibleTo?.({ subject: 'nobody', groups: [] }, config)).toBe(false);
  });

  it('MCP-11 answers the upload URL and only the caller own files, newest first, metadata only', async () => {
    const { run } = await setup();
    const result = await run(ALICE);
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { uploadUrl: string; files: { id: string; name: string }[] };
    expect(structured.uploadUrl).toBe('https://mandate.example.test/app/files');
    expect(structured.files.map((f) => f.id)).toEqual([ID_B, ID_A]);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Upload files at https://mandate.example.test/app/files. You have 2 staged file(s): b (1).png (' + ID_B + '), a.png (' + ID_A + ')',
    });
  });

  it('MCP-11 SEC-3 no content and nothing of another user appears in the answer', async () => {
    const { run } = await setup();
    const result = await run(ALICE);
    const json = JSON.stringify(result);
    expect(json).not.toContain(BOB_NAME);
    expect(json).not.toContain(BOB_HASH);
    expect(json).not.toContain(ID_BOB);
    expect(json).not.toContain(Buffer.from([1, 2, 3]).toString('base64'));
    expect(Object.keys((result.structuredContent as { files: object[] }).files[0] ?? {}).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'mediaType', 'name', 'preview', 'sha256', 'size']);
  });

  it('MCP-11 with no staged file the text only gives the upload URL and a zero count', async () => {
    const { run } = await setup();
    const result = await run({ subject: 'carol', groups: ['editors'] });
    expect(result.content[0]).toEqual({ type: 'text', text: 'Upload files at https://mandate.example.test/app/files. You have 0 staged file(s)' });
    expect(result.structuredContent).toMatchObject({ files: [] });
  });
});
