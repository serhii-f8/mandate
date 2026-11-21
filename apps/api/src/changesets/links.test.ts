// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createTaskResult } from '../mcp/tasks/task-result.js';
import { changesetIdOf, pageLink, withPageLink } from './links.js';

const ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC = new URL('https://aiops.example.test');
const URL_OF_ID = `https://aiops.example.test/app/changesets/${ID}`;

/** A prepared-like answer: summary, the structured data again as JSON, and the structured data. */
function prepared(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: 'text', text: 'Prepared.' },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

describe('MCP-6 page links', () => {
  it('MCP-6 pageLink is <public>/app/changesets/<id>', () => {
    expect(pageLink(PUBLIC, ID)).toBe(URL_OF_ID);
    expect(pageLink(new URL('http://127.0.0.1:8400/'), ID)).toBe(`http://127.0.0.1:8400/app/changesets/${ID}`);
  });

  it('MCP-6 withPageLink appends " Open: <url>" to the first text block and adds pageUrl', () => {
    const answer: CallToolResult = { content: [{ type: 'text', text: 'Started.' }], structuredContent: { changesetId: ID, status: 'executing' }, isError: true };
    expect(withPageLink(answer, PUBLIC)).toEqual({
      content: [{ type: 'text', text: `Started. Open: ${URL_OF_ID}` }],
      structuredContent: { changesetId: ID, status: 'executing', pageUrl: URL_OF_ID },
      isError: true,
    });
    // A new object: the input is not changed.
    expect(answer).toEqual({ content: [{ type: 'text', text: 'Started.' }], structuredContent: { changesetId: ID, status: 'executing' }, isError: true });
  });

  it('MCP-6 withPageLink rewrites the JSON block that repeats structuredContent, and leaves any other second block alone', () => {
    const structured = { changeset: { id: ID, status: 'prepared' }, items: [{ targetId: 'a' }] };
    const linked = withPageLink(prepared(structured), PUBLIC);
    expect(linked.structuredContent).toEqual({ ...structured, pageUrl: URL_OF_ID });
    expect(linked.content[0]).toEqual({ type: 'text', text: `Prepared. Open: ${URL_OF_ID}` });
    expect(JSON.parse((linked.content[1] as { text: string }).text)).toEqual(linked.structuredContent);

    const other: CallToolResult = {
      content: [
        { type: 'text', text: 'Prepared.' },
        { type: 'text', text: 'not the data' },
      ],
      structuredContent: structured,
    };
    expect(withPageLink(other, PUBLIC).content[1]).toEqual({ type: 'text', text: 'not the data' });
  });

  it('MCP-6 changesetId works like changeset.id', () => {
    expect(changesetIdOf({ changesetId: ID })).toBe(ID);
    expect(changesetIdOf({ changeset: { id: ID } })).toBe(ID);
    expect(changesetIdOf({ changeset: { id: ID.toUpperCase() } })).toBe(ID.toUpperCase());
    const linked = withPageLink({ content: [{ type: 'text', text: 'x' }], structuredContent: { changesetId: ID } }, PUBLIC);
    expect(linked.structuredContent).toEqual({ changesetId: ID, pageUrl: URL_OF_ID });
  });

  it('MCP-6 a text that already holds the URL is not changed, and applying twice equals applying once', () => {
    const pending: CallToolResult = {
      content: [{ type: 'text', text: `Awaits approval. Approvers decide on ${URL_OF_ID}.` }],
      structuredContent: { changesetId: ID, status: 'pending_approval' },
    };
    const once = withPageLink(pending, PUBLIC);
    expect(once.content).toEqual(pending.content);
    expect(once.structuredContent).toEqual({ changesetId: ID, status: 'pending_approval', pageUrl: URL_OF_ID });

    const linkedOnce = withPageLink(prepared({ changeset: { id: ID } }), PUBLIC);
    expect(withPageLink(linkedOnce, PUBLIC)).toEqual(linkedOnce);
    expect(withPageLink(once, PUBLIC)).toEqual(once);
  });

  it('MCP-6 no ID, a non-UUID ID or a task answer: unchanged', () => {
    const none: CallToolResult = { content: [{ type: 'text', text: 'pong' }] };
    const noId: CallToolResult = { content: [{ type: 'text', text: 'x' }], structuredContent: { items: [] } };
    const notUuid: CallToolResult = { content: [{ type: 'text', text: 'x' }], structuredContent: { changesetId: '../admin', changeset: { id: 'cs-1' } } };
    const nonString: CallToolResult = { content: [{ type: 'text', text: 'x' }], structuredContent: { changesetId: 7, changeset: 'x' } };
    for (const answer of [none, noId, notUuid, nonString]) expect(withPageLink(answer, PUBLIC)).toBe(answer);
    expect(changesetIdOf(undefined)).toBeUndefined();
    expect(changesetIdOf({ changeset: null })).toBeUndefined();
    const task = createTaskResult({
      taskId: '22222222-2222-4222-8222-222222222222',
      owner: 'alice',
      changesetId: ID,
      kind: 'execute',
      tool: 'submit_for_approval',
      createdAt: new Date(0),
      ttlMs: 1000,
    });
    expect(withPageLink(task, PUBLIC)).toBe(task);
  });
});
