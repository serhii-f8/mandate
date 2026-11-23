// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Inject, Module, type DynamicModule, type INestApplication, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { trace } from '@opentelemetry/api';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import { createAdapters } from '@mandate/adapters';
import type { McpToolAdapter, ReadAdapter } from '@mandate/connector-sdk';
import { ConfigurationUnavailableError, createSchemaCompiler, type ApiEnv, type ConfigurationHolder } from '@mandate/config';
import {
  changesetKind,
  HARD_MAX_FILE_BYTES,
  rolesOf,
  type AuditLog,
  type ChangeSetExecutor,
  type ChangeSetRepository,
  type CredentialVault,
  type FileStore,
  type OperationInvoker,
  type RateCounter,
  type TaskRepository,
  type WorkflowStarter,
} from '@mandate/core';
import { parseTemporalKeys, TemporalExecutor, TemporalWorkflowStarter } from '@mandate/temporal';
import type { Client, Connection } from '@temporalio/client';
import { createDb, DrizzleAuditLog, parseMasterKeys, PostgresAuditReader, PostgresChangeSetRepository, PostgresCredentialVault, PostgresFileStore, PostgresRateCounter, PostgresSessionStore, PostgresTaskRepository, type Database } from '@mandate/db';
import { createBearerGate } from './auth/bearer-gate.js';
import { createJwtVerifier } from './auth/jwt-verifier.js';
import { ProtectedResourceController } from './auth/protected-resource.controller.js';
import { HealthController } from './health/health.controller.js';
import { bodyErrorHandler } from './http/body-errors.js';
import { EndpointRateLimiter } from './http/rate-limiter.js';
import { configurationGate } from './config/configuration-gate.js';
import { createLogger, PinoNestLogger } from './logger.js';
import { ApprovalService } from './approvals/approval-service.js';
import { AuditController } from './audit/audit.controller.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import { ChangeSetPagesController } from './approvals/changeset-pages.controller.js';
import { ChangeSetActionsController } from './changesets/changeset-actions.controller.js';
import { SubmitService } from './changesets/submit-service.js';
import { FilesController } from './files/files.controller.js';
import { ChangeSetExportController } from './export/export.controller.js';
import { createBuiltinTools } from './mcp/builtin-tools.js';
import { McpController } from './mcp/mcp.controller.js';
import { createServerFactory } from './mcp/mcp-server-factory.js';
import { createPipelineTelemetry, NO_TELEMETRY, type PipelineTelemetry } from './mcp/pipeline-telemetry.js';
import { snapshotOf, type PipelineDeps } from './mcp/tool-pipeline.js';
import { resolveWidgetDir, WidgetBundles } from './mcp/widget-bundles.js';
import {
  API_ENV,
  APPROVAL_SERVICE,
  AUDIT_LOG,
  AUDIT_READER,
  BEARER_GATE,
  CHANGESET_EXECUTOR,
  CHANGESET_REPOSITORY,
  CONFIGURATION,
  CONNECTION_TEST,
  CREDENTIAL_VAULT,
  DATABASE,
  FILE_STORE,
  LOGGER,
  MCP_HANDLER,
  OIDC_CLIENT,
  ON_SHUTDOWN,
  PAGE_CHECKS,
  PAGE_SESSIONS,
  PIN_MONITOR,
  RATE_COUNTER,
  RATE_LIMITER,
  SUBMIT_SERVICE,
  TELEMETRY,
  TEMPORAL,
  TRACER,
  WIDGET_BUNDLES,
  WORKFLOW_STARTER,
} from './tokens.js';
import { createApiTemporalClient } from './temporal-client.js';
import type { ApiTelemetry } from './telemetry.js';
import { ConnectionTestService } from './upstream/connection-test.js';
import { operationInvokers, type OperationInvokersBase } from './upstream/operation-router.js';
import { assertFullyChecked, PinMonitor, vaultToolLister, type UpstreamToolView } from '@mandate/upstream';
import { PageAccessGuard, type PageChecks } from './web/access.js';
import { AuthController, SessionController } from './web/auth.controller.js';
import { ConnectionsController } from './web/connections.controller.js';
import { CredentialsController } from './web/credentials.controller.js';
import { createOidcClient } from './web/oidc-client.js';
import { SessionService } from './web/session.service.js';
import { WebAppController } from './web/static.js';

/** Seams the tests replace. */
export interface AppOverrides {
  /** Runs allowed operations, all risk classes; defaults to routing by risk (`operationInvokers`). */
  readonly invoker?: OperationInvoker;
  /** Change-set store; defaults to `PostgresChangeSetRepository` on the api database. */
  readonly changesets?: ChangeSetRepository;
  /**
   * The upstream adapter; `main.ts` passes the one whose resolver loaded the configuration.
   * Defaults to `createAdapters()`. With `listTools` the api runs the pin monitor (CONN-4).
   */
  readonly adapter?: ReadAdapter & Partial<McpToolAdapter>;
  /** Pin states of MCP-backed operations; replaces the pin monitor (none is built). */
  readonly upstreamTools?: UpstreamToolView;
  /** Credential store; defaults to `PostgresCredentialVault` under `MANDATE_MASTER_KEYS`. */
  readonly vault?: CredentialVault;
  /** Signing keys; defaults to the remote JWKS at `OIDC_JWKS_URL`. */
  readonly jwks?: JWTVerifyGetKey;
  /** Runs prepared change-sets; defaults to `TemporalExecutor` (EXE-11). */
  readonly executor?: ChangeSetExecutor;
  /** Starts the change-set workflow that prepares it; defaults to `TemporalWorkflowStarter` (EXE-1). */
  readonly starter?: WorkflowStarter;
  /** Tasks store; defaults to `PostgresTaskRepository` on the api database (MCP-7). */
  readonly tasks?: TaskRepository;
  /** Rate-limit counters; defaults to `PostgresRateCounter` on the api database (POL-4, NFR-3). */
  readonly rateCounter?: RateCounter;
  /** Wall-clock time of the rate-limit windows, endpoint (SEC-10) and pipeline (POL-4); the real clock by default. */
  readonly wallClock?: () => Date;
  /** Runs after the api's own resources closed; `main.ts` stops the configuration sync and its database here. */
  readonly onShutdown?: () => Promise<void>;
}

interface UpstreamIo {
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter & Partial<McpToolAdapter>;
  readonly repository: ChangeSetRepository;
  readonly log: NonNullable<OperationInvokersBase['log']>;
  readonly upstreamTools: UpstreamToolView | undefined;
}

/** The api's Temporal client, present unless the tests replace both its users. */
interface TemporalHandle {
  readonly connection: Connection;
  readonly client: Client;
}

/** The invoker per call: the override, or the risk router bound to the request's snapshot. */
function invokerFactory(
  override: OperationInvoker | undefined,
  io: UpstreamIo,
  write: { tasks: TaskRepository; starter: WorkflowStarter; prepareWaitMs: number },
): PipelineDeps['invokerFor'] {
  if (override !== undefined) return () => override;
  return operationInvokers({
    vault: io.vault,
    adapter: io.adapter,
    repository: io.repository,
    tasks: write.tasks,
    starter: write.starter,
    prepareWaitMs: write.prepareWaitMs,
    newId: randomUUID,
    now: () => new Date(),
    log: io.log,
    ...(io.upstreamTools === undefined ? {} : { upstreamTools: io.upstreamTools }),
  });
}

/**
 * The pin monitor's run (CONN-4): `createApp` starts it once a configuration is active, and a
 * start that arrives after `stop()` is ignored, since the database is closed by then.
 */
class PinMonitorRun {
  private closed = false;
  constructor(readonly monitor: PinMonitor) {}

  start(): void {
    if (!this.closed) this.monitor.start();
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.monitor.stop();
  }
}

/** Closes the per-process resources when the application shuts down, then runs the caller's `onShutdown`. */
class Resources implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(MCP_HANDLER) private readonly handler: McpHttpHandler,
    @Inject(TEMPORAL) private readonly temporal: TemporalHandle | null,
    @Inject(ON_SHUTDOWN) private readonly onShutdown: (() => Promise<void>) | null,
    @Inject(TELEMETRY) private readonly telemetry: ApiTelemetry | null,
    @Inject(PIN_MONITOR) private readonly pinMonitor: PinMonitorRun | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // First: its checks write audit rows, so it stops while the database is still open.
    await this.pinMonitor?.stop();
    await this.handler.close();
    await this.temporal?.connection.close();
    await this.database.close();
    await this.onShutdown?.();
    // Last: spans of the shutdown above are still exported (NFR-11).
    await this.telemetry?.shutdown();
  }
}

@Module({})
class AppModule {
  static forRoot(env: ApiEnv, logger: Logger, configuration: ConfigurationHolder, overrides: AppOverrides, telemetry: ApiTelemetry | undefined): DynamicModule {
    // Parsed eagerly so a malformed key set stops the start (SEC-2); the message names no key material.
    const keys = overrides.vault === undefined ? parseMasterKeys(env.masterKeys) : undefined;
    // Likewise the Temporal payload keys (SEC-4), whenever a Temporal client is built.
    const temporalKeys = overrides.executor === undefined || overrides.starter === undefined ? parseTemporalKeys(env.temporalKeys) : undefined;
    const adapter = overrides.adapter ?? createAdapters();
    // One wall clock for the endpoint limits and the pipeline's calls_per_minute: the same windows.
    const wallClock = overrides.wallClock ?? ((): Date => new Date());
    // Without telemetry the api's spans go to the global tracer (a no-op unless one is registered) and no metric is counted.
    const pipelineTelemetry: PipelineTelemetry = telemetry === undefined ? NO_TELEMETRY : createPipelineTelemetry({ tracer: telemetry.tracer, meter: telemetry.meter });
    // One key set for MCP access tokens and page ID tokens: same issuer.
    const jwks = overrides.jwks ?? createRemoteJWKSet(env.oidcJwksUrl);
    const verifier = createJwtVerifier({
      issuer: env.oidcIssuer,
      audience: env.mcpResource.href,
      jwks,
      // Read per token, so an applied configuration takes effect at once (AUTH-4). Plan call 7:
      // without an active configuration no client is a service account (fails closed); any other
      // failure propagates.
      isServiceAccount: (id) => {
        try {
          return configuration.current.serviceAccounts.has(id);
        } catch (e) {
          if (e instanceof ConfigurationUnavailableError) return false;
          throw e;
        }
      },
    });
    const oidc = createOidcClient({
      authorizationUrl: env.oidcAuthorizationUrl,
      tokenUrl: env.oidcTokenUrl,
      issuer: env.oidcIssuer,
      clientId: env.webClientId,
      clientSecret: env.webClientSecret,
      redirectUri: new URL('/auth/callback', env.publicUrl).href,
      jwks,
    });
    // One set of SEC-8 settings for the guard and the credential controllers.
    const pageChecks: PageChecks = { publicOrigin: env.publicUrl.origin, freshAuthSeconds: env.freshAuthSeconds };
    return {
      module: AppModule,
      controllers: [McpController, ProtectedResourceController, HealthController, AuthController, SessionController, CredentialsController, ConnectionsController, ApprovalsController, ChangeSetPagesController, ChangeSetExportController, ChangeSetActionsController, AuditController, FilesController, WebAppController],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: LOGGER, useValue: logger },
        { provide: CONFIGURATION, useValue: configuration },
        { provide: ON_SHUTDOWN, useValue: overrides.onShutdown ?? null },
        { provide: TRACER, useValue: telemetry?.tracer ?? trace.getTracer('mandate-api') },
        { provide: TELEMETRY, useValue: telemetry ?? null },
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
        {
          // Lazy: the api starts, and serves everything but execution, while Temporal is down (ADR 0029).
          // `null` when the tests replace both the executor and the starter.
          provide: TEMPORAL,
          useFactory: (): TemporalHandle | null => {
            if (temporalKeys === undefined) return null;
            return createApiTemporalClient(env, temporalKeys);
          },
        },
        { provide: AUDIT_LOG, inject: [DATABASE], useFactory: (d: Database) => new DrizzleAuditLog(d.db, { sensitiveKeys: () => configuration.current.sensitiveFields }) },
        { provide: AUDIT_READER, inject: [DATABASE], useFactory: (d: Database) => new PostgresAuditReader(d.pool) },
        {
          // One counter for the pipeline's calls_per_minute (POL-4) and the endpoint limits (SEC-10), shared across instances (NFR-3).
          provide: RATE_COUNTER,
          inject: [DATABASE],
          useFactory: (d: Database): RateCounter => overrides.rateCounter ?? new PostgresRateCounter(d.db),
        },
        {
          provide: RATE_LIMITER,
          inject: [RATE_COUNTER, AUDIT_LOG],
          useFactory: (rateCounter: RateCounter, audit: AuditLog) => new EndpointRateLimiter({ rateCounter, audit, wallClock, logger }),
        },
        { provide: FILE_STORE, inject: [DATABASE], useFactory: (d: Database): FileStore => new PostgresFileStore(d.db) },
        {
          provide: CREDENTIAL_VAULT,
          inject: [DATABASE],
          useFactory: (d: Database): CredentialVault =>
            // `keys` is set exactly when no vault override was given (above).
            overrides.vault ?? new PostgresCredentialVault(d.db, keys ?? parseMasterKeys(env.masterKeys)),
        },
        {
          // One repository for the write path, the built-in change-set tools and the approval pages.
          provide: CHANGESET_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: Database): ChangeSetRepository => overrides.changesets ?? new PostgresChangeSetRepository(database.db),
        },
        {
          provide: CHANGESET_EXECUTOR,
          inject: [CHANGESET_REPOSITORY, TEMPORAL],
          useFactory: (changesets: ChangeSetRepository, temporal: TemporalHandle | null): ChangeSetExecutor =>
            overrides.executor ?? new TemporalExecutor({ client: temporalOf(temporal).client, taskQueue: env.taskQueue, repository: changesets, newId: randomUUID, now: () => new Date() }),
        },
        {
          // One approval service for the MCP decision tool and the page routes (ADR 0032).
          provide: APPROVAL_SERVICE,
          inject: [CHANGESET_REPOSITORY, CHANGESET_EXECUTOR, AUDIT_LOG],
          useFactory: (repository: ChangeSetRepository, executor: ChangeSetExecutor, audit: AuditLog) =>
            new ApprovalService({ repository, executor, audit, newId: randomUUID, now: () => new Date() }),
        },
        {
          // One submit service for `submit_for_approval` and the page's submit route (MCP-8).
          provide: SUBMIT_SERVICE,
          inject: [CHANGESET_REPOSITORY, CHANGESET_EXECUTOR, AUDIT_LOG, APPROVAL_SERVICE],
          useFactory: (repository: ChangeSetRepository, executor: ChangeSetExecutor, audit: AuditLog, approvals: ApprovalService) =>
            new SubmitService({ repository, executor, audit, approvals, newId: randomUUID, now: () => new Date() }),
        },
        {
          // One starter for the write path's preparations and derived change-sets (EXE-1).
          provide: WORKFLOW_STARTER,
          inject: [TEMPORAL],
          useFactory: (temporal: TemporalHandle | null): WorkflowStarter =>
            overrides.starter ?? new TemporalWorkflowStarter({ client: temporalOf(temporal).client, taskQueue: env.taskQueue }),
        },
        {
          // Read once at start; a missing or empty bundle is warned about and left out (MCP-5, MCP-6).
          provide: WIDGET_BUNDLES,
          useFactory: (): Promise<WidgetBundles> =>
            WidgetBundles.load(resolveWidgetDir(env.widgetDir), (m, d) => {
              logger.warn(d, m);
            }),
        },
        {
          // CONN-4: pin states of MCP-backed operations; started by `createApp`, stopped first by `Resources`.
          provide: PIN_MONITOR,
          inject: [AUDIT_LOG, CREDENTIAL_VAULT],
          useFactory: (audit: AuditLog, vault: CredentialVault): PinMonitorRun | null => {
            // Bound: an adapter may implement it as a method.
            const listTools = adapter.listTools?.bind(adapter);
            if (overrides.upstreamTools !== undefined || listTools === undefined) return null;
            const monitor = new PinMonitor({
              configuration: () => configuration.current,
              lister: vaultToolLister({ listTools }, vault),
              audit,
              newId: randomUUID,
              logger,
              compile: createSchemaCompiler(),
            });
            return new PinMonitorRun(monitor);
          },
        },
        {
          provide: MCP_HANDLER,
          inject: [AUDIT_LOG, CREDENTIAL_VAULT, DATABASE, CHANGESET_REPOSITORY, CHANGESET_EXECUTOR, APPROVAL_SERVICE, WORKFLOW_STARTER, WIDGET_BUNDLES, PIN_MONITOR, RATE_COUNTER],
          useFactory: (
            audit: AuditLog,
            vault: CredentialVault,
            database: Database,
            changesets: ChangeSetRepository,
            executor: ChangeSetExecutor,
            approvals: ApprovalService,
            starter: WorkflowStarter,
            widgets: WidgetBundles,
            pinMonitor: PinMonitorRun | null,
            rateCounter: RateCounter,
          ) => {
            // One task store for the write path that creates tasks and the handlers that read them.
            const tasks = overrides.tasks ?? new PostgresTaskRepository(database.db);
            // Without either, MCP-backed operations are never listed and always refused (fail closed).
            const upstreamTools = overrides.upstreamTools ?? pinMonitor?.monitor;
            const io: UpstreamIo = {
              vault,
              adapter,
              repository: changesets,
              log: (record) => {
                logger.info(record, 'upstream call completed');
              },
              upstreamTools,
            };
            return createMcpHandler(
              createServerFactory(
                {
                  snapshot: () => snapshotOf(configuration.current),
                  builtins: createBuiltinTools(
                    {
                      repository: changesets,
                      newId: randomUUID,
                      now: () => new Date(),
                      executor,
                      tasks,
                      audit,
                      approvals,
                      publicUrl: env.publicUrl,
                      ...(upstreamTools === undefined ? {} : { upstreamTools }),
                    },
                    {
                      starter,
                      // The derived change-set stays prepared; submitting it starts the workflow anyway (signalWithStart).
                      onStartFailure: (id, e) => {
                        logger.warn({ changesetId: id, err: e instanceof Error ? e.name : 'unknown' }, 'workflow start after derivation failed');
                      },
                    },
                  ),
                  invokerFor: invokerFactory(overrides.invoker, io, { tasks, starter, prepareWaitMs: env.prepareWaitMs }),
                  audit,
                  newId: randomUUID,
                  now: () => performance.now(),
                  rateCounter,
                  wallClock,
                  widgets,
                  publicUrl: env.publicUrl,
                  telemetry: pipelineTelemetry,
                  ...(upstreamTools === undefined ? {} : { upstreamTools }),
                },
                {
                  tasks,
                  repository: changesets,
                  executor,
                  audit,
                  newId: randomUUID,
                  publicUrl: env.publicUrl,
                  kindOf: (operationId) => changesetKind(configuration.current.policy.operations.find((op) => op.id === operationId)),
                },
              ),
              {
                legacy: 'stateless',
                responseMode: 'json',
                onerror: (error) => {
                  logger.warn({ err: error.message }, 'mcp request rejected');
                },
              },
            );
          },
        },
        {
          provide: CONNECTION_TEST,
          inject: [AUDIT_LOG, CREDENTIAL_VAULT],
          useFactory: (audit: AuditLog, vault: CredentialVault) =>
            new ConnectionTestService({ configuration: () => configuration.current, vault, adapter, audit, newId: randomUUID }),
        },
        { provide: PAGE_CHECKS, useValue: pageChecks },
        { provide: OIDC_CLIENT, useValue: oidc },
        {
          provide: PAGE_SESSIONS,
          inject: [DATABASE],
          useFactory: (d: Database) => new SessionService(new PostgresSessionStore(d.db), { maxAgeSeconds: env.sessionMaxAgeSeconds }),
        },
        {
          // SEC-1: every route is denied unless marked @Public or @PageAccess.
          provide: APP_GUARD,
          inject: [PAGE_SESSIONS],
          useFactory: (sessions: SessionService) =>
            new PageAccessGuard(new Reflector(), sessions, (session) => rolesOf(session, configuration.current.policy), pageChecks),
        },
        Resources,
      ],
    };
  }
}

/** The Temporal client; built whenever an executor or starter override is missing (above). */
function temporalOf(temporal: TemporalHandle | null): TemporalHandle {
  if (temporal === null) throw new Error('Temporal client not configured');
  return temporal;
}

export interface CreateAppOptions {
  readonly env: ApiEnv;
  /** The active configuration (CFG-2); loaded by the caller so a bad one stops the start. */
  readonly configuration: ConfigurationHolder;
  readonly overrides?: AppOverrides;
  readonly logger?: Logger;
  /** Tracer and meter of the api (NFR-11, NFR-12); the app shuts it down last. Without it: `NO_TELEMETRY` and the global tracer. */
  readonly telemetry?: ApiTelemetry;
}

/** The one request whose body is raw bytes: `POST /api/v1/files` (CS-10). Matched as Express routes it: case-insensitive, optional trailing slash, query ignored. */
function isFileUpload(req: IncomingMessage): boolean {
  return req.method === 'POST' && /^\/api\/v1\/files\/?(\?|$)/i.test(req.url ?? '');
}

/** Builds the api application without listening (used by `main.ts` and the e2e tests). */
export async function createApp(options: CreateAppOptions): Promise<INestApplication> {
  // The api checks fully: specs resolved and presets loaded (CONN-2, ADR 0021). Without an active
  // configuration there is nothing to check; the gate below answers 503 until one is (CFG-2).
  if (options.configuration.state().status === 'active') assertFullyChecked(options.configuration.current);
  const logger = options.logger ?? createLogger(options.env.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(options.env, logger, options.configuration, options.overrides ?? {}, options.telemetry),
    // NestFactory types its options as a class; a plain object is what Nest documents.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
    { logger: new PinoNestLogger(logger), bodyParser: false },
  );
  // SEC-10: `req.ip` honours X-Forwarded-For only across the configured number of proxy hops (0: none).
  app.set('trust proxy', options.env.trustProxy);
  // CS-10: an upload is the raw bytes of any content type, up to the hard file limit. This parser reads
  // only `POST /api/v1/files` (its `type` test); it must come first: once it has read the stream, the
  // JSON parser below finds the request finished and skips it, so an `application/json` upload is not
  // re-serialised and the 4 MiB JSON limit does not apply to it.
  // `inflate: false`: the stored bytes are the bytes sent, so a compressed upload is refused (415), not decompressed.
  app.useBodyParser('raw', { type: isFileUpload, limit: HARD_MAX_FILE_BYTES, inflate: false });
  // MCP request bodies up to 4 MiB, the SDK's default bound (ADR 0013).
  app.useBodyParser('json', { limit: '4mb' });
  // Directly after the parser: its errors quote the body, so they get fixed bodies (SEC-3).
  app.use(bodyErrorHandler);
  // CFG-2, SEC-1: no request reaches a route that reads the configuration while none is active.
  app.use(configurationGate(options.configuration));
  // CONN-4: pin checks start once a configuration is active (its first tick lists every mcp connection).
  const pinMonitor = app.get<PinMonitorRun | null>(PIN_MONITOR);
  if (pinMonitor !== null) {
    void options.configuration.whenActive().then(() => {
      pinMonitor.start();
    });
  }
  return app;
}
