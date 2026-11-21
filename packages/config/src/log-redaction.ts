// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** Keys whose values are censored wherever the paths below reach them (SEC-3). */
const SENSITIVE_KEYS = ['password', 'secret', 'token', 'client_secret', 'authorization', 'access_token', 'refresh_token', 'id_token'] as const;

/**
 * Paths pino censors in every record, a safety net under the rule that no code logs
 * headers, bodies or secrets (SEC-3). Each sensitive key is matched at the root of the record
 * (`token`), one level below it (`*.token`) and two levels below it (`*.*.token`): a pino
 * wildcard matches exactly one level and never the root itself.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];
