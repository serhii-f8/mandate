// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { mayStageFiles } from './access.js';

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
      { id: 'empty', grants: [] },
    ],
    role_mapping: [],
  }),
};

async function configuration(): Promise<LoadedConfiguration> {
  const result = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.configuration;
}

describe('CS-10 who may stage files', () => {
  it('CS-10 is false for no roles, for roles without grants and for roles whose operations declare no files', async () => {
    const c = await configuration();
    expect(mayStageFiles([], c)).toBe(false);
    expect(mayStageFiles(['empty'], c)).toBe(false);
    expect(mayStageFiles(['noter'], c)).toBe(false);
    expect(mayStageFiles(['unknown'], c)).toBe(false);
  });

  it('CS-10 is true for a role granting an operation that declares files', async () => {
    const c = await configuration();
    expect(mayStageFiles(['editor'], c)).toBe(true);
    expect(mayStageFiles(['noter', 'editor'], c)).toBe(true);
  });
});
