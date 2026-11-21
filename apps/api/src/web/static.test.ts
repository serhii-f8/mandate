// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import { resolveWebDir, WebAppController } from './static.js';

describe('UI-5 the api finds the web bundle', () => {
  it('UI-5 AIOPS_WEB_DIR wins and is made absolute', () => {
    expect(resolveWebDir('some/dir')).toBe(resolve('some/dir'));
  });

  it('UI-5 without AIOPS_WEB_DIR the development bundle apps/web/dist is used', () => {
    expect(resolveWebDir(undefined).endsWith(join('apps', 'web', 'dist'))).toBe(true);
  });

  it('UI-5 a missing bundle answers 404 and logs one line, with the security headers still set', async () => {
    const warn = vi.fn();
    const controller = new WebAppController({ webDir: '/nonexistent-aiops-web-dir' } as ApiEnv, { warn } as unknown as Logger);
    const headers = new Map<string, string>();
    const status = vi.fn().mockReturnThis();
    const res = {
      setHeader: (k: string, v: string) => headers.set(k, v),
      status,
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as unknown as Response;
    await controller.file(['credentials'], res);
    await controller.index(res);
    expect(status).toHaveBeenCalledWith(404);
    expect(warn).toHaveBeenCalledOnce();
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
