import type { NextFunction, Request, Response } from 'express';

/**
 * Express error middleware for the JSON body parser. Its errors carry a message that
 * quotes part of the request body, which may hold a secret: answer with fixed bodies
 * instead, and never log or echo the input (SEC-3). Applies to every route, `/mcp`
 * included. Errors that are not body-parser errors pass on unchanged.
 */
export function bodyErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const type = bodyParserErrorType(error);
  if (type === undefined) {
    next(error);
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  const status = statusOf(error);
  res.status(status >= 400 && status < 500 ? status : 400).json({ error: 'invalid_body' });
}

/** body-parser errors are `http-errors` with a string `type` such as `entity.parse.failed`. */
function bodyParserErrorType(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('type' in error)) return undefined;
  const { type } = error;
  return typeof type === 'string' && /^(entity|request|encoding|charset|stream)\./.test(type) ? type : undefined;
}

function statusOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') return error.status;
  return 400;
}
