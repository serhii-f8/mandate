import 'reflect-metadata';
import { Inject, Module, type DynamicModule, type INestApplication, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import { createDb, DrizzleAuditLog, type Database } from '@aiops/db';
import { HealthController } from './health/health.controller.js';
import { createLogger, PinoNestLogger } from './logger.js';
import { AnonymousCallerResolver, CALLER_RESOLVER, type CallerResolver } from './mcp/caller-resolver.js';
import { McpController } from './mcp/mcp.controller.js';
import { createServerFactory } from './mcp/mcp-server-factory.js';
import { pingTool } from './mcp/ping.tool.js';
import { StaticToolCatalog, TOOL_CATALOG, type ToolCatalog } from './mcp/tool-catalog.js';
import { API_ENV, AUDIT_LOG, DATABASE, LOGGER, MCP_HANDLER } from './tokens.js';

/** Seams the tests replace (and Phase 2 replaces for real). */
export interface AppOverrides {
  readonly callerResolver?: CallerResolver;
  readonly toolCatalog?: ToolCatalog;
}

/** Closes the per-process resources when the application shuts down. */
class Resources implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(MCP_HANDLER) private readonly handler: McpHttpHandler,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handler.close();
    await this.database.close();
  }
}

@Module({})
class AppModule {
  static forRoot(env: ApiEnv, logger: Logger, overrides: AppOverrides): DynamicModule {
    return {
      module: AppModule,
      controllers: [McpController, HealthController],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: LOGGER, useValue: logger },
        { provide: DATABASE, useFactory: () => createDb(env.databaseUrl) },
        { provide: AUDIT_LOG, inject: [DATABASE], useFactory: (d: Database) => new DrizzleAuditLog(d.db) },
        { provide: CALLER_RESOLVER, useValue: overrides.callerResolver ?? new AnonymousCallerResolver() },
        { provide: TOOL_CATALOG, useValue: overrides.toolCatalog ?? new StaticToolCatalog([pingTool]) },
        {
          provide: MCP_HANDLER,
          inject: [TOOL_CATALOG, AUDIT_LOG],
          useFactory: (catalog: ToolCatalog, audit: DrizzleAuditLog) =>
            createMcpHandler(createServerFactory({ catalog, audit }), {
              legacy: 'stateless',
              responseMode: 'json',
              onerror: (error) => {
                logger.warn({ err: error.message }, 'mcp request rejected');
              },
            }),
        },
        Resources,
      ],
    };
  }
}

export interface CreateAppOptions {
  readonly env: ApiEnv;
  readonly overrides?: AppOverrides;
  readonly logger?: Logger;
}

/** Builds the api application without listening (used by `main.ts` and the e2e tests). */
export async function createApp(options: CreateAppOptions): Promise<INestApplication> {
  const logger = options.logger ?? createLogger(options.env.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(options.env, logger, options.overrides ?? {}),
    // NestFactory types its options as a class; a plain object is what Nest documents.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
    { logger: new PinoNestLogger(logger), bodyParser: false },
  );
  // MCP request bodies up to 4 MiB, the SDK's default bound (ADR 0013).
  app.useBodyParser('json', { limit: '4mb' });
  return app;
}
