// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Curated operations and manifests for Gitea issues (preset `preset.yaml`, CONN-8 second preset).
 * The default export is the code module of `mandate.code` (OPS-5): the two code reads and the label
 * writer. The SDK is imported as types only, so the built module needs nothing but its own files.
 */
import { fileURLToPath } from 'node:url';
import type { PresetModule } from '@mandate/connector-sdk';
import { setLabels } from './labels.js';
import { getIssues, searchIssues } from './reads.js';

/** Absolute directory of this preset package (holds `package.json`, `preset.yaml` and `spec/`); same from `src/` and `dist/`. */
export const PRESET_DIR: string = fileURLToPath(new URL('..', import.meta.url));

export default {
  operations: {
    search_issues: { kind: 'read', read: searchIssues },
    get_issues: { kind: 'read', read: getIssues },
    set_labels: { kind: 'write', write: setLabels },
  },
} satisfies PresetModule;
