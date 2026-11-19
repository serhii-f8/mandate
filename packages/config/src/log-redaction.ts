/**
 * Paths pino censors in every record, a safety net under the rule that no code logs
 * headers, bodies or secrets (SEC-3). `*.x` matches one level below the root.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.client_secret',
  '*.authorization',
];
