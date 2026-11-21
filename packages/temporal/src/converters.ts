// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VersionedKeys } from '@aiops/core';
import { defaultPayloadConverter, type DataConverter, type LoadedDataConverter } from '@temporalio/common';
import { createPayloadCodec } from './codec.js';
import { failureConverter } from './failure-converter.js';

/** The failure converter module, `.ts` under tests and `.js` in the built package. */
export const FAILURE_CONVERTER_PATH = fileURLToPath(
  new URL(`./failure-converter${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/**
 * Data converter for `@temporalio/client` (api, worker-side clients, scripts): encrypted
 * payloads and encoded failure attributes (SEC-3, SEC-4).
 *
 * In @temporalio 1.25.0 `DataConverter` has no `failureConverter` field: the client reads only
 * `failureConverterPath` unless it is handed an already loaded converter (`isLoadedDataConverter`
 * in `base-client.js`). A loaded converter avoids `require()`-ing a module path from ESM.
 */
export function clientDataConverter(keys: VersionedKeys): LoadedDataConverter {
  return {
    payloadConverter: defaultPayloadConverter,
    failureConverter,
    payloadCodecs: [createPayloadCodec(keys)],
  };
}

/**
 * Data converter for `Worker.create`: the failure converter must be given by path, because
 * workflow code runs in the bundled sandbox; the client-side setting alone leaves workflow
 * failure messages in plaintext history (ADR 0027, Verified).
 */
export function workerDataConverter(keys: VersionedKeys): DataConverter {
  return {
    payloadCodecs: [createPayloadCodec(keys)],
    failureConverterPath: FAILURE_CONVERTER_PATH,
  };
}
