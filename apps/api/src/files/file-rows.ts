// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** The files of a change-set as the page detail and the tools show them: metadata only, never content (APR-5, UI-7, SEC-3). */
import type { FilePreview, FileStore } from '@mandate/core';

export interface FileRow {
  readonly pointer: string;
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly preview: FilePreview;
  /** False once the content was purged. */
  readonly available: boolean;
}

/** One row per linked file, ordered by pointer; empty when the change-set has none. */
export async function fileRows(store: Pick<FileStore, 'ofChangeSet'>, changesetId: string): Promise<FileRow[]> {
  return (await store.ofChangeSet(changesetId)).map(({ pointer, file }) => ({
    pointer,
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    sha256: file.sha256,
    preview: file.preview,
    available: file.purgedAt === undefined,
  }));
}
