import { DrizzleQueryError } from 'drizzle-orm';

/** Postgres error code of `error` or of its cause (drizzle wraps driver errors). */
function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * A database error leaves as a fixed message carrying only its code, without `cause`:
 * drizzle's error quotes the statement and its parameters (target IDs, outcome texts,
 * cursors, error codes), and the driver's `detail` quotes key values (SEC-3). Errors of
 * our own (validation, an injected audit failure) pass unchanged.
 */
function databaseError(what: string, error: unknown): unknown {
  const code = pgCode(error);
  if (code === undefined && !(error instanceof DrizzleQueryError)) return error;
  const message = code === '23505' && what === 'change-set create' ? 'change-set already exists' : `${what} failed`;
  return Object.assign(new Error(code === undefined ? message : `${message} (sqlstate ${code})`), code === undefined ? {} : { code });
}

export async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw databaseError(what, error);
  }
}
