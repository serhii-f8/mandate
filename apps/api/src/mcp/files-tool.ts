// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `list_staged_files` (MCP-11, CS-10): where to upload a file and the caller's own staged files, so the model
 * can find the ID of what the person just uploaded. Visible to the callers who may stage files; to anyone else
 * the tool does not exist (MCP-2). Metadata only, and only the caller's own files (SEC-1, SEC-3).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler } from '@mandate/config';
import { rolesOf, type FileStore } from '@mandate/core';
import { fileView, mayStageFiles } from '../files/access.js';
import type { BuiltinTool } from './tool-catalog.js';

export const LIST_STAGED_FILES_TOOL = 'list_staged_files';

/** The same bound as the page's own-file listing. */
const LISTING_LIMIT = 200;

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const validate = createSchemaCompiler()(SCHEMA);

export interface ListStagedFilesDeps {
  readonly files: Pick<FileStore, 'ownedBy'>;
  /** `MANDATE_PUBLIC_URL`: base of the upload page. */
  readonly publicUrl: URL;
}

export function createListStagedFilesTool(deps: ListStagedFilesDeps): BuiltinTool {
  return {
    name: LIST_STAGED_FILES_TOOL,
    description: 'Show where to upload a file and the files you have staged, with their IDs. Pass an ID to an operation that takes a file.',
    inputSchema: SCHEMA,
    readOnlyHint: true,
    validate,
    visibleTo: (caller, configuration) => mayStageFiles(rolesOf(caller, configuration.policy), configuration),
    async handler(_args, { caller, snapshot }): Promise<CallToolResult> {
      const files = (await deps.files.ownedBy(caller.subject, LISTING_LIMIT)).map((file) => fileView(file, snapshot.configuration.files));
      const uploadUrl = new URL('/app/files', deps.publicUrl).href;
      const list = files.length === 0 ? '' : `: ${files.map((f) => `${f.name} (${f.id})`).join(', ')}`;
      const text = `Upload files at ${uploadUrl}. You have ${String(files.length)} staged file(s)${list}`;
      const structured = { uploadUrl, files };
      // MCP-4: summary first, then the structured data as JSON.
      return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    },
  };
}
