// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Operation input schemas (MCP-3): JSON Schema 2020-12 compiled with Ajv in strict
 * mode at load time, so a broken schema is a configuration error, not a runtime one.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';

export type ArgumentCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };
export type ArgumentValidator = (args: unknown) => ArgumentCheck;

// ajv-formats is CommonJS; under `nodenext` its default import is the module object
// whose `default` is the plugin, while at run time it can be the plugin itself.
const addFormats: (ajv: Ajv2020) => unknown =
  typeof addFormatsPlugin === 'function' ? addFormatsPlugin : (addFormatsPlugin as { default: (ajv: Ajv2020) => unknown }).default;

export function createSchemaCompiler(): (schema: Readonly<Record<string, unknown>>) => ArgumentValidator {
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  addFormats(ajv);
  return (schema) => {
    const validate = ajv.compile(schema);
    return (args) =>
      validate(args) ? { ok: true } : { ok: false, message: ajv.errorsText(validate.errors, { dataVar: 'arguments' }) };
  };
}
