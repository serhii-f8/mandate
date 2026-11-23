// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { ConfigurationStateSource, LoadedConfiguration } from '@mandate/config';
import { sessionCookieValue } from '../web/session.service.js';

export interface UploadGateOptions {
  /** The upload route, the same predicate the raw body parser reads with. */
  readonly isUpload: (req: IncomingMessage) => boolean;
  readonly configuration: ConfigurationStateSource & { readonly current: Pick<LoadedConfiguration, 'files'> };
  /** Whether the session cookie carries the `__Host-` prefix (an https public origin). */
  readonly secureCookie: boolean;
}

/**
 * CS-10, SEC-1: early refusals of `POST /api/v1/files`, before the raw parser buffers up to the hard file
 * limit. Without a session cookie the answer is the page guard's 401 `unauthenticated`; with a
 * `Content-Length` above the current `files.max_bytes` (read per request, so a reload applies at once) it is
 * 413 `payload_too_large`. Neither reads the body. Only refusals: the cookie's presence admits nothing, the
 * page guard still authenticates and the controller still checks the size of what it read. While no
 * configuration is active the request passes on to the configuration gate (CFG-2).
 */
export function uploadGate(options: UploadGateOptions): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!options.isUpload(req) || options.configuration.state().status !== 'active') {
      next();
      return;
    }
    if (sessionCookieValue(req.headers.cookie, options.secureCookie) === undefined) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && /^\d+$/.test(length) && Number(length) > options.configuration.current.files.maxBytes) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    next();
  };
}
