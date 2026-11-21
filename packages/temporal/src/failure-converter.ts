// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Loaded by path (`failureConverterPath`) by the worker and bundled into workflow code, so it
 * imports only `@temporalio/common`. Failure messages and stack traces are moved into the
 * encoded attributes, which the payload codec encrypts (SEC-3, SEC-4).
 */
import { DefaultFailureConverter } from '@temporalio/common';

export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });
