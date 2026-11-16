import type { ConnectionSettings } from './connection.js';
import type { HttpMethod, UpstreamMapping } from './mapping.js';

export interface CatalogEntry {
  key: string;
  operationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  inputSchema: Record<string, unknown>;
  defaultMapping: UpstreamMapping;
}

export interface SpecIssue {
  path: readonly (string | number)[];
  message: string;
}

export interface UpstreamResolver {
  resolveSpec(input: {
    connection: ConnectionSettings;
    spec: { file: string } | { url: string };
    include?: readonly string[];
  }): Promise<{ ok: true; catalog: readonly CatalogEntry[] } | { ok: false; issues: readonly SpecIssue[] }>;
}
