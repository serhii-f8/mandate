// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuditAction, AuditOutcome } from '../audit.js';

/** Filters of an audit search (AUD-6). Every field is optional; present fields are combined with AND. */
export interface AuditSearchFilter {
  readonly actor?: string;
  readonly action?: AuditAction;
  readonly outcome?: AuditOutcome;
  readonly changesetId?: string;
  readonly correlationId?: string;
  /** Inclusive lower bound on `ts`. */
  readonly from?: Date;
  /** Exclusive upper bound on `ts`. */
  readonly to?: Date;
}

/** One stored audit event as a search answers it (AUD-6). `seq` is a decimal string. */
export interface AuditRecord {
  readonly seq: string;
  readonly id: string;
  readonly ts: string;
  readonly actor: string;
  readonly clientId: string | null;
  readonly action: string;
  readonly subject: string | null;
  readonly decision: string | null;
  readonly outcome: string;
  readonly correlationId: string;
  readonly changesetId: string | null;
  readonly details: Record<string, unknown>;
  readonly chainPos: number | null;
}

/** Read port over the audit log (AUD-6). Implemented in `@aiops/db`. */
export interface AuditReader {
  /** Newest first; `beforeSeq` excludes it and everything newer. `more` is true when older matching rows exist. */
  search(
    filter: AuditSearchFilter,
    page: { readonly limit: number; readonly beforeSeq?: string },
  ): Promise<{ events: AuditRecord[]; more: boolean }>;
}
