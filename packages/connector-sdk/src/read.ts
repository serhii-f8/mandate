import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { UpstreamMapping } from './mapping.js';

export type ReadErrorCode =
  | 'timeout'
  | 'egress_denied'
  | 'http_status'
  | 'invalid_response'
  | 'credential_missing'
  | 'credential_unusable'
  | 'network'
  | 'busy'
  | 'mapping';

export type ReadOutcome =
  | {
      ok: true;
      status: number;
      durationMs: number;
      items?: readonly Record<string, unknown>[];
      total?: number;
      value?: unknown;
      truncated: boolean;
    }
  | { ok: false; code: ReadErrorCode; status?: number; durationMs: number; message: string };

export interface ScopeReport {
  detectable: boolean;
  source: 'oauth_token_response' | 'jwt_claims' | 'none';
  values: readonly string[];
}

export interface ConnectionTestReport {
  ok: boolean;
  operation: string;
  status?: number;
  durationMs: number;
  itemCount?: number;
  code?: ReadErrorCode;
  message?: string;
  scopes: ScopeReport;
}

export interface ReadAdapter {
  read(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    args: Readonly<Record<string, unknown>>;
    credential?: CredentialSource;
  }): Promise<ReadOutcome>;
  detectScopes(input: { connection: ConnectionSettings; credential?: CredentialSource }): Promise<ScopeReport>;
}
