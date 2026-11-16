import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Module, type DynamicModule, type INestApplication, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import { createOpenApiAdapter } from '@aiops/adapters';
import type { ReadAdapter } from '@aiops/connector-sdk';
import type { ApiEnv, ConfigurationHolder } from '@aiops/config';
import type { AuditLog, CredentialVault, OperationInvoker } from '@aiops/core';
import { createDb, DrizzleAuditLog, parseMasterKeys, PostgresCredentialVault, type Database } from '@aiops/db';
import { createBearerGate } from './auth/bearer-gate.js';
import { createJwtVerifier } from './auth/jwt-verifier.js';
import { ProtectedResourceController } from './auth/protected-resource.controller.js';
import { HealthController } from './health/health.controller.js';
import { createLogger, PinoNestLogger } from './logger.js';
import { BUILTIN_TOOLS } from './mcp/builtin-tools.js';
import { McpController } from './mcp/mcp.controller.js';
import { createServerFactory } from './mcp/mcp-server-factory.js';
import { snapshotOf } from './mcp/tool-pipeline.js';
import { API_ENV, AUDIT_LOG, BEARER_GATE, CONFIGURATION, CREDENTIAL_VAULT, DATABASE, LOGGER, MCP_HANDLER } from './tokens.js';
import { DirectReadInvoker } from './upstream/read-invoker.js';
import { assertFullyChecked } from './upstream/upstream-runtime.js';

/** Seams the tests replace. */
export interface AppOverrides {
  /** Runs allowed operations; defaults to the direct read path (`DirectReadInvoker`). */
  readonly invoker?: OperationInvoker;
  /** The read adapter; `main.ts` passes the one whose resolver loaded the configuration. Defaults to a new OpenAPI adapter. */
  readonly adapter?: ReadAdapter;
  /** Credential store; defaults to `PostgresCredentialVault` under `AIOPS_MASTER_KEYS`. */
  readonly vault?: CredentialVault;
  /** Signing keys; defaults to the remote JWKS at `OIDC_JWKS_URL`. */
  readonly jwks?: JWTVerifyGetKey;
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
  static forRoot(env: ApiEnv, logger: Logger, configuration: ConfigurationHolder, overrides: AppOverrides): DynamicModule {
    // Parsed eagerly so a malformed key set stops the start (SEC-2); the message names no key material.
    const keys = overrides.vault === undefined ? parseMasterKeys(env.masterKeys) : undefined;
    const adapter = overrides.adapter ?? createOpenApiAdapter();
    const verifier = createJwtVerifier({
      issuer: env.oidcIssuer,
      audience: env.mcpResource.href,
      jwks: overrides.jwks ?? createRemoteJWKSet(env.oidcJwksUrl),
    });
    return {
      module: AppModule,
      controllers: [McpController, ProtectedResourceController, HealthController],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: LOGGER, useValue: logger },
        { provide: CONFIGURATION, useValue: configuration },
        { provide: BEARER_GATE, useValue: createBearerGate({ verifier, resource: env.mcpResource }) },
        {
          provide: DATABASE,
          useFactory: () =>
            createDb(env.databaseUrl, {
              onError: (error) => {
                logger.warn({ err: error.message }, 'idle database connection failed');
              },
            }),
        },
        { provide: AUDIT_LOG, inject: [DATABASE], useFactory: (d: Database) => new DrizzleAuditLog(d.db) },
        {
          provide: CREDENTIAL_VAULT,
          inject: [DATABASE],
          useFactory: (d: Database): CredentialVault =>
            // `keys` is set exactly when no vault override was given (above).
            overrides.vault ?? new PostgresCredentialVault(d.db, keys ?? parseMasterKeys(env.masterKeys)),
        },
        {
          provide: MCP_HANDLER,
          inject: [AUDIT_LOG, CREDENTIAL_VAULT],
          useFactory: (audit: AuditLog, vault: CredentialVault) =>
            createMcpHandler(
              createServerFactory({
                snapshot: () => snapshotOf(configuration.current),
                builtins: BUILTIN_TOOLS,
                invoker: overrides.invoker ?? new DirectReadInvoker({ configuration: () => configuration.current, vault, adapter }),
                audit,
                newId: randomUUID,
                now: () => performance.now(),
              }),
              {
                legacy: 'stateless',
                responseMode: 'json',
                onerror: (error) => {
                  logger.warn({ err: error.message }, 'mcp request rejected');
                },
              },
            ),
        },
        Resources,
      ],
    };
  }
}

export interface CreateAppOptions {
  readonly env: ApiEnv;
  /** The active configuration (CFG-2); loaded by the caller so a bad one stops the start. */
  readonly configuration: ConfigurationHolder;
  readonly overrides?: AppOverrides;
  readonly logger?: Logger;
}

/** Builds the api application without listening (used by `main.ts` and the e2e tests). */
export async function createApp(options: CreateAppOptions): Promise<INestApplication> {
  // The api checks fully: specs resolved and presets loaded (CONN-2, ADR 0021).
  assertFullyChecked(options.configuration.current);
  const logger = options.logger ?? createLogger(options.env.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(options.env, logger, options.configuration, options.overrides ?? {}),
    // NestFactory types its options as a class; a plain object is what Nest documents.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
    { logger: new PinoNestLogger(logger), bodyParser: false },
  );
  // MCP request bodies up to 4 MiB, the SDK's default bound (ADR 0013).
  app.useBodyParser('json', { limit: '4mb' });
  return app;
}
