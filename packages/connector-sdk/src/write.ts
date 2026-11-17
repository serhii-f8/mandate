import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { UpstreamMapping } from './mapping.js';
import type { ReadErrorCode } from './read.js';

export type WriteErrorCode = ReadErrorCode | 'rejected';
export type BulkItemState = 'ok' | 'failed' | 'retriable' | 'open';

export interface WriteFailure {
  ok: false;
  code: WriteErrorCode;
  status?: number;
  durationMs: number;
  retriable: boolean;
}

export type BulkSubmitOutcome = { ok: true; batchId: string; status: number; durationMs: number } | WriteFailure;
export type BulkStatusOutcome =
  | { ok: true; items: readonly { index: number; state: BulkItemState }[]; durationMs: number }
  | WriteFailure;

export interface WriteAdapter {
  submitBulk(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    records: readonly Readonly<Record<string, unknown>>[];
    credential?: CredentialSource;
  }): Promise<BulkSubmitOutcome>;
  bulkStatus(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    batchId: string;
    credential?: CredentialSource;
  }): Promise<BulkStatusOutcome>;
}
