// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The compiler the configuration loader uses for operation input schemas (same options as
 * packages/config/src/argument-validators.ts): Ajv 2020-12 in strict mode plus ajv-formats.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';

// ajv-formats is CommonJS; under `nodenext` its default import is the module object
// whose `default` is the plugin, while at run time it can be the plugin itself.
const addFormats: (ajv: Ajv2020) => unknown =
  typeof addFormatsPlugin === 'function' ? addFormatsPlugin : (addFormatsPlugin as { default: (ajv: Ajv2020) => unknown }).default;

export function strictAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  addFormats(ajv);
  return ajv;
}

export function loadSpec(name: string): Record<string, unknown> {
  const file = fileURLToPath(new URL(`./fixtures/specs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}
