// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Who may stage files and how a staged file is shown on the trusted page (CS-10). */
import type { LoadedConfiguration } from '@mandate/config';
import type { FilePreview, FileSettings, StagedFile } from '@mandate/core';

/**
 * True when one of `roles` has a grant on an operation that declares file arguments (OPS-8).
 * No role, no grant or no such operation: false (routes are denied by default).
 */
export function mayStageFiles(roles: readonly string[], configuration: Pick<LoadedConfiguration, 'policy'>): boolean {
  const withFiles = new Set(configuration.policy.operations.filter((op) => (op.files?.length ?? 0) > 0).map((op) => op.id));
  if (withFiles.size === 0) return false;
  return configuration.policy.roles.some((role) => roles.includes(role.id) && role.grants.some((grant) => withFiles.has(grant.operation)));
}

/** A staged file as the page and the listing tool show it: metadata only, never the content (SEC-3). */
export interface FileView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly preview: FilePreview;
  readonly createdAt: string;
  /**
   * `createdAt` plus `files.staged_ttl_hours`: the content is removed at this time if the file is not used by a
   * change-set. A file linked to a change-set keeps its content until `files.keep_days` after that change-set
   * ends, so for such a file this time does not apply (CS-10).
   */
  readonly expiresAt: string;
}

export function fileView(file: StagedFile, settings: Pick<FileSettings, 'stagedTtlHours'>): FileView {
  return {
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    sha256: file.sha256,
    preview: file.preview,
    createdAt: file.createdAt.toISOString(),
    expiresAt: new Date(file.createdAt.getTime() + settings.stagedTtlHours * 3_600_000).toISOString(),
  };
}
