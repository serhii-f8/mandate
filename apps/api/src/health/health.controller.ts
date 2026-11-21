import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Connection } from '@temporalio/client';
import { configurationProbe, PRODUCT_VERSION, probeWithin, readinessStatus, type ConfigurationStateSource, type ReadinessReport } from '@aiops/config';
import type { Database } from '@aiops/db';
import { CONFIGURATION, DATABASE, TEMPORAL } from '../tokens.js';
import { Public } from '../web/access.js';

const PROBE_MS = 2000;
/** `grpc.health.v1.HealthCheckResponse.ServingStatus.SERVING` (the proto enum is not a direct dependency). */
const SERVING = 1;

/** Liveness and readiness for Compose healthchecks; readiness per NFR-10. */
@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationStateSource,
    @Inject(TEMPORAL) private readonly temporal: { readonly connection: Connection } | null,
  ) {}

  @Get('healthz')
  @HttpCode(200)
  live(): { ok: true; version: string } {
    return { ok: true, version: PRODUCT_VERSION };
  }

  @Get('readyz')
  async ready(@Res() res: Response): Promise<void> {
    const [database, temporal] = await Promise.all([
      probeWithin(() => this.database.pool.query('SELECT 1'), PROBE_MS),
      this.temporalProbe(),
    ]);
    const report: ReadinessReport = { database, configuration: configurationProbe(this.configuration.state()), temporal };
    // The api does not require Temporal: it starts and serves while Temporal is down (ADR 0029).
    res.status(readinessStatus(report, false)).set('cache-control', 'no-store').json(report);
  }

  /** Never `ensureConnected()`: it memoises a rejection (ruling F6). A health RPC connects lazily. */
  private temporalProbe(): Promise<ReadinessReport['temporal']> {
    const connection = this.temporal?.connection;
    if (connection === undefined) return Promise.resolve('unavailable');
    return probeWithin(async () => {
      const response = await connection.withDeadline(Date.now() + PROBE_MS, () => connection.healthService.check({}));
      const status: number = response.status;
      if (status !== SERVING) throw new Error('not serving');
    }, PROBE_MS + 500);
  }
}
