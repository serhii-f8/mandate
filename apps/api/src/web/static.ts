// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, resolve, sep } from 'node:path';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import { API_ENV, LOGGER } from '../tokens.js';
import { Public } from './access.js';

/** The web bundle in a development checkout: `apps/web/dist`, next to `apps/api`. */
const DEVELOPMENT_WEB_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));

/** `AIOPS_WEB_DIR` when set, else the development bundle location (absolute either way). */
export function resolveWebDir(webDir: string | undefined): string {
  return resolve(webDir ?? DEVELOPMENT_WEB_DIR);
}

/** Headers of every static response (UI-5: the credential page is framed by nobody and loads from this origin only). */
export const STATIC_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** A path under `/app/` is safe when every segment is a plain name: no dot segments, separators or NUL. */
function plainSegments(path: readonly string[]): boolean {
  return path.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0'));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built `apps/web` bundle under `/app/` (UI-5). Static files hold no data, so the
 * routes are public (SEC-1); the data comes from `/api/v1`, which is guarded. Unknown paths
 * without a file extension get `index.html` (client-side route); files are never served from
 * outside the bundle directory.
 */
@Controller('app')
@Public()
export class WebAppController {
  private readonly root: string;
  private warned = false;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.root = resolveWebDir(env.webDir);
  }

  @Get()
  index(@Res() res: Response): Promise<undefined> {
    return this.serve([], res);
  }

  @Get('*path')
  file(@Param('path') path: string | string[], @Res() res: Response): Promise<undefined> {
    return this.serve(Array.isArray(path) ? path : [path], res);
  }

  private async serve(path: readonly string[], res: Response): Promise<undefined> {
    for (const [name, value] of Object.entries(STATIC_HEADERS)) res.setHeader(name, value);
    const notFound = (): void => {
      res.status(404).type('text/plain').send('Not found');
    };
    if (!plainSegments(path)) {
      notFound();
      return undefined;
    }
    const candidate = join(this.root, ...path);
    // join() cannot leave the root with plain segments; kept as a second, independent check.
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      notFound();
      return undefined;
    }
    let file = candidate;
    let isIndex = false;
    if (path.length === 0 || !(await isFile(candidate))) {
      // A missing asset (a name with an extension) is a 404; a missing route is the app shell.
      if (path.length > 0 && extname(candidate) !== '') {
      notFound();
      return undefined;
    }
      file = join(this.root, 'index.html');
      isIndex = true;
    }
    if (!(await isFile(file))) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn('web bundle not found; /app is not served (set AIOPS_WEB_DIR or build apps/web)');
      }
      notFound();
      return undefined;
    }
    // HTML must not be cached (a new bundle changes the asset names); hashed assets may be.
    res.setHeader('cache-control', isIndex || extname(file) === '.html' ? 'no-store' : 'public, max-age=3600');
    await new Promise<void>((done) => {
      res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, (error) => {
        if (error !== undefined && !res.headersSent) notFound();
        done();
      });
    });
    return undefined;
  }
}
