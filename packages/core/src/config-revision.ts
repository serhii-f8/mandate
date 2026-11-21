// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuditEventInput } from './audit.js';

/** How a configuration revision came to be (CFG-4): applied by an operator, or bootstrapped from files on first start. */
export type ConfigRevisionSource = 'apply' | 'bootstrap';

/** Entity counts of a revision, shown in listings without loading its files. */
export interface ConfigRevisionSummary {
  readonly connections: number;
  readonly operations: number;
  readonly roles: number;
  readonly notifications: number;
}

/** A revision as handed to the store. `files` maps a path relative to the configuration directory (with `/`) to its text. */
export interface NewConfigRevision {
  readonly id: string;
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly actor: string;
  readonly summary: ConfigRevisionSummary;
}

/** A stored revision. The store assigns `seq`, `source` and `appliedAt`. */
export interface ConfigRevision extends NewConfigRevision {
  readonly seq: number;
  readonly source: ConfigRevisionSource;
  readonly appliedAt: Date;
}

export type ApplyRevisionResult =
  | { readonly ok: true; readonly revision: ConfigRevision }
  | { readonly ok: false; readonly reason: 'concurrent_apply' | 'unchanged' };

/** Callbacks of a change listener (CFG-3). `onReconnect` follows every reconnect, so missed notifications can be caught up. */
export interface ConfigListenerHandlers {
  onChange(): void;
  onReconnect(): void;
  onError(message: string): void;
}

export interface ConfigListener {
  close(): Promise<void>;
}

/** CFG-4: the stored configuration revisions. The active one has the highest seq. */
export interface ConfigRevisionStore {
  active(): Promise<ConfigRevision | undefined>;
  /** The seq of the active revision, without reading its files; undefined when none exists. */
  activeSeq(): Promise<number | undefined>;
  /** Inserts `revision` as source 'bootstrap', actor 'system', only when no revision exists; returns the active one either way. */
  bootstrap(revision: Omit<NewConfigRevision, 'actor'>): Promise<ConfigRevision>;
  /** One transaction: refuses unless the active hash (null when none) equals `expectedPreviousHash`, refuses `unchanged` when it equals `revision.hash`; else inserts source 'apply', appends `audit`, notifies. */
  apply(revision: NewConfigRevision, audit: AuditEventInput, expectedPreviousHash: string | null): Promise<ApplyRevisionResult>;
  listen(handlers: ConfigListenerHandlers): Promise<ConfigListener>;
}
