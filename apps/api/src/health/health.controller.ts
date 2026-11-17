import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Database } from '@aiops/db';
import { DATABASE } from '../tokens.js';
import { Public } from '../web/access.js';

/** Liveness and readiness for Compose healthchecks (the NFR-10 requirement itself is Phase 8). */
@Controller()
@Public()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get('healthz')
  @HttpCode(200)
  live(): { ok: true } {
    return { ok: true };
  }

  @Get('readyz')
  async ready(@Res() res: Response): Promise<void> {
    try {
      await this.database.pool.query('SELECT 1');
      res.status(200).json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  }
}
