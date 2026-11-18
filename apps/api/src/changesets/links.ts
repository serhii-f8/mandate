/**
 * The fallback link to the change-set page (MCP-6): every result that refers to a change-set the
 * caller may see names its page, so clients without MCP Apps widgets still reach it. Applied after
 * the audit row is written, so the audit never holds the URL. Only the UUID-shaped ID enters it.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { CHANGESET_ID } from '../approvals/page-query.js';
import { isTaskAnswer, type ToolAnswer } from '../mcp/tasks/task-result.js';

export function pageLink(publicUrl: URL, id: string): string {
  return new URL(`/app/changesets/${id}`, publicUrl).href;
}

const uuid = (value: unknown): string | undefined => (typeof value === 'string' && CHANGESET_ID.test(value) ? value : undefined);

/** The UUID-shaped `changeset.id` or `changesetId` of structured content, else undefined. */
export function changesetIdOf(structured: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (structured === undefined) return undefined;
  const changeset = structured.changeset;
  const nested = typeof changeset === 'object' && changeset !== null ? uuid((changeset as Record<string, unknown>).id) : undefined;
  return nested ?? uuid(structured.changesetId);
}

/** Global Constraints "Fallback link"; returns task answers and answers without an ID unchanged; idempotent. */
export function withPageLink<T extends ToolAnswer>(answer: T, publicUrl: URL): T {
  if (isTaskAnswer(answer)) return answer;
  const result: CallToolResult = answer;
  // `structuredContent` is `unknown` in the SDK type; only an object can name a change-set.
  const raw = result.structuredContent;
  const old = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Readonly<Record<string, unknown>>) : undefined;
  const id = changesetIdOf(old);
  if (id === undefined) return answer;
  const url = pageLink(publicUrl, id);
  const structuredContent = { ...old, pageUrl: url };
  const oldJson = JSON.stringify(old);
  const first = result.content.findIndex((block) => block.type === 'text');
  // New blocks and a new object: shared answer constants are never changed.
  const content = result.content.map((block, i) => {
    if (block.type !== 'text') return block;
    if (i === 1 && block.text === oldJson) return { ...block, text: JSON.stringify(structuredContent) };
    if (i === first && !block.text.includes(url)) return { ...block, text: `${block.text} Open: ${url}` };
    return block;
  });
  // `T` is `CallToolResult` here (task answers returned above); the spread keeps every other field.
  return { ...result, content, structuredContent } as T;
}
