/** Tasks extension detection (MCP-7, MCP-1): declared per request in `_meta`, never negotiated. */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the request `_meta` declares the extension with an object value. */
export function declaresTasks(envelope: object | undefined): boolean {
  if (!isObject(envelope)) return false;
  const capabilities = envelope[CLIENT_CAPABILITIES_KEY];
  if (!isObject(capabilities) || !isObject(capabilities.extensions)) return false;
  return isObject(capabilities.extensions[TASKS_EXTENSION]);
}

export function missingTasksCapability(): ProtocolError {
  return new ProtocolError(-32021, 'Missing required client capability', { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
}

export function taskNotFound(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
}
