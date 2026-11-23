// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditEventInput } from '../audit.js';
import type { FilePreview, StagedFile } from './model.js';

/** Storage of staged files (CS-10). Implemented by the database package. */
export interface FileStore {
  /** Inserts under a per-owner lock; refuses when the owner's files with content would exceed either quota. The audit event is appended in the same transaction. */
  stage(
    input: {
      id: string;
      owner: string;
      clientId?: string;
      name: string;
      mediaType: string;
      content: Uint8Array;
      sha256: string;
      preview: FilePreview;
      createdAt: Date;
      quota: { count: number; bytes: number };
    },
    audit: AuditEventInput,
  ): Promise<{ ok: true; file: StagedFile } | { ok: false; code: 'quota_exceeded' }>;
  /** Unknown and non-UUID IDs give undefined. */
  get(id: string): Promise<StagedFile | undefined>;
  /** The owner's files that still have content, newest first, then id; limit 1..200. */
  ownedBy(owner: string, limit: number): Promise<readonly StagedFile[]>;
  /** undefined when unknown, non-UUID or purged. */
  content(id: string): Promise<Uint8Array | undefined>;
  /** Ordered by pointer; unknown and non-UUID change-set IDs give []. */
  ofChangeSet(changesetId: string): Promise<readonly { pointer: string; file: StagedFile }[]>;
  /** Removes content per spec 4.2 "Lifetime"; returns the number of files purged, at most `limit`. */
  purge(
    input: { now: Date; stagedTtlHours: number; keepDays: number; limit: number },
    audit: (purged: number) => AuditEventInput,
  ): Promise<number>;
}
