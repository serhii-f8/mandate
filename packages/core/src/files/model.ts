// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors

export type FileSend = 'base64' | 'multipart';
export type FilePreview = 'image' | 'text' | 'none';

/** One declared file argument of an operation (OPS-8). `pointer` is `/` + `path.join('/')`. */
export interface FileArgument {
  readonly pointer: string;
  readonly path: readonly string[];
  readonly send: FileSend;
  readonly mediaTypes: readonly string[];
  readonly maxBytes: number;
  readonly part?: string;
}

/** A staged file's metadata (CS-10); the content is read separately and never travels with it. */
export interface StagedFile {
  readonly id: string;
  readonly owner: string;
  readonly clientId?: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly preview: FilePreview;
  readonly createdAt: Date;
  readonly purgedAt?: Date;
}

/** What replaces the file ID in a change-set's stored arguments, under `{ "$file": ... }` (CS-10). */
export interface FileDescriptor {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
  readonly sha256: string;
}

/** A change-set's link to a staged file: the pointer of the argument and the file. */
export interface FileLink {
  readonly pointer: string;
  readonly fileId: string;
}

export interface FileSettings {
  readonly maxBytes: number;
  readonly stagedTtlHours: number;
  readonly keepDays: number;
  readonly perUserCount: number;
  readonly perUserBytes: number;
}

export const DEFAULT_FILE_SETTINGS: FileSettings = {
  maxBytes: 10_485_760,
  stagedTtlHours: 24,
  keepDays: 7,
  perUserCount: 50,
  perUserBytes: 262_144_000,
};

/** The largest `files.max_bytes` a configuration may set (25 MiB). */
export const HARD_MAX_FILE_BYTES = 26_214_400;
/** How many leading bytes of a text file the approval preview shows and the text check reads. */
export const TEXT_PREVIEW_BYTES = 65_536;
