/**
 * Pin state of MCP-backed operations, held per process (CONN-4; design phase 9 §3, ADR 0051).
 * Seeded from the load-time tool list, refreshed every `pin_check_seconds` per connection and
 * on the call path, and every change of an operation's state is audited as `upstream.pin`
 * (AUD-1). Only identifiers, states and hashes leave this module: no upstream text reaches a
 * row or a log record (SEC-5).
 */
import {
  createSchemaCompiler,
  pinStateOf,
  toMcpCatalog,
  type ArgumentValidator,
  type LoadedConfiguration,
  type McpCatalogState,
  type McpOperationBinding,
  type PinEvaluation,
  type PinState,
} from '@aiops/config';
import type { ConnectionSettings, McpToolAdapter, ToolListOutcome } from '@aiops/connector-sdk';
import type { AuditLog, CredentialVault } from '@aiops/core';
import { connectionCredential } from './read.js';

/** Lists the tools of one `mcp` connection; the credential is the lister's business. */
export type ToolLister = (connection: ConnectionSettings) => Promise<ToolListOutcome>;

/** A lister that opens the connection's credential from the vault (SEC-2): opened only inside the adapter. */
export function vaultToolLister(adapter: Pick<McpToolAdapter, 'listTools'>, vault: CredentialVault): ToolLister {
  return async (connection) => {
    const credential = await connectionCredential(vault, connection.credentialRef);
    if (credential === 'unusable') {
      return { ok: false, code: 'credential_unusable', durationMs: 0, message: 'the stored credential has an unknown scheme' };
    }
    return adapter.listTools({ connection, ...(credential === undefined ? {} : { credential }) });
  };
}

export interface UpstreamToolView {
  /** NFR-6: synchronous, in memory; undefined when the operation is not MCP-backed. */
  view(configuration: LoadedConfiguration, operationId: string): PinEvaluation | undefined;
  /**
   * Refreshes the operation's connection first when its last successful list and its last
   * list attempt are both older than the freshness window `min(60 s, pin_check_seconds)`, so a
   * failing upstream is listed at most once per window (R4 still turns it `unverified`). A
   * caller arriving while a list is in flight waits for that list.
   */
  current(configuration: LoadedConfiguration, operationId: string): Promise<PinEvaluation | undefined>;
  /**
   * R9: schedules, without waiting, a refresh of each stale connection of these operations;
   * stale as for `current` (last success and last attempt both older than the freshness window).
   */
  touch(configuration: LoadedConfiguration, operationIds: readonly string[]): void;
}

export interface PinMonitorDeps {
  readonly configuration: () => LoadedConfiguration;
  readonly lister: ToolLister;
  readonly audit: AuditLog;
  readonly newId: () => string;
  /** Defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly logger: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /** Defaults to `createSchemaCompiler()`. */
  readonly compile?: (s: Readonly<Record<string, unknown>>) => ArgumentValidator;
}

const TICK_MS = 1000;
/** The call path and R9 refresh a connection whose last list is older than `min(60 s, pin_check_seconds)`. */
const MAX_FRESHNESS_MS = 60_000;
/** Matches the configuration schema default; used only if a connection has no entry. */
const DEFAULT_PIN_CHECK_SECONDS = 300;

interface ConnectionState {
  settings: ConnectionSettings;
  pinCheckMs: number;
  /** The last `listed` catalog; never replaced by a failed list (R4 decides how long it counts). */
  catalog: McpCatalogState | undefined;
  lastSuccessAt: number | undefined;
  lastAttemptAt: number | undefined;
  inFlight: Promise<void> | undefined;
  /** Compiled validators (or the compile failure) by `<tool>\0<hash>`, for the current catalog only. */
  readonly validators: Map<string, ArgumentValidator | Error>;
}

const keyOf = (settings: ConnectionSettings): string => `${settings.id}\0${settings.baseUrl}`;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

function mcpBinding(configuration: LoadedConfiguration, operationId: string): McpOperationBinding | undefined {
  const binding = configuration.bindings.get(operationId);
  return binding?.kind === 'mcp' ? binding : undefined;
}

/** A lister answer as a catalog; a rejecting lister is a fault, treated like an unreachable upstream. */
async function listCatalog(lister: ToolLister, settings: ConnectionSettings, clock: () => number): Promise<McpCatalogState> {
  let outcome: ToolListOutcome;
  try {
    outcome = await lister(settings);
  } catch {
    return { status: 'unlisted', code: 'network' };
  }
  return toMcpCatalog(outcome, clock());
}

export class PinMonitor implements UpstreamToolView {
  private readonly clock: () => number;
  private readonly compile: (s: Readonly<Record<string, unknown>>) => ArgumentValidator;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly seeded = new WeakSet<LoadedConfiguration>();
  /** The last audited (or silently recorded first-seen `ok`) state per operation ID (R12). */
  private readonly recorded = new Map<string, PinState>();
  /** Evaluations run one after another, so a transition is never audited twice. */
  private evaluation: Promise<void> = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: PinMonitorDeps) {
    this.clock = deps.clock ?? Date.now;
    this.compile = deps.compile ?? createSchemaCompiler();
  }

  /** First tick now, then every second; the timer never keeps the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.runTick();
    this.timer = setInterval(() => {
      this.runTick();
    }, TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
    await Promise.all([...this.connections.values()].flatMap((c) => (c.inFlight === undefined ? [] : [c.inFlight])));
    await this.evaluation;
  }

  /** Refreshes every connection whose periodic check is due, then evaluates and audits transitions. */
  async tick(): Promise<void> {
    const configuration = this.deps.configuration();
    const states = this.statesOf(configuration);
    // Connections the current configuration no longer has (removed, or a new base URL) are dropped.
    for (const [key, state] of this.connections) if (!states.has(key) && state.inFlight === undefined) this.connections.delete(key);
    const now = this.clock();
    const due = [...states.values()].filter((c) => c.lastAttemptAt === undefined || now - c.lastAttemptAt >= c.pinCheckMs);
    await Promise.all(due.map((c) => this.refresh(c)));
    await this.evaluate();
  }

  view(configuration: LoadedConfiguration, operationId: string): PinEvaluation | undefined {
    const binding = mcpBinding(configuration, operationId);
    if (binding === undefined) return undefined;
    const connection = this.connectionOf(configuration, binding);
    if (connection === undefined) return { state: 'unverified', liveHash: null };
    // R4: a list older than 2 × pin_check_seconds no longer counts.
    const fresh = connection.lastSuccessAt !== undefined && this.clock() - connection.lastSuccessAt <= 2 * connection.pinCheckMs;
    return pinStateOf(binding, fresh ? connection.catalog : undefined, (schema) => this.cachedCompile(connection, binding, schema));
  }

  async current(configuration: LoadedConfiguration, operationId: string): Promise<PinEvaluation | undefined> {
    const binding = mcpBinding(configuration, operationId);
    if (binding === undefined) return undefined;
    const connection = this.connectionOf(configuration, binding);
    // A caller that arrives while a refresh is in flight waits for it too (one list, shared).
    if (connection !== undefined && (connection.inFlight !== undefined || this.stale(connection))) await this.refresh(connection);
    return this.view(configuration, operationId);
  }

  touch(configuration: LoadedConfiguration, operationIds: readonly string[]): void {
    for (const operationId of operationIds) {
      const binding = mcpBinding(configuration, operationId);
      if (binding === undefined) continue;
      const connection = this.connectionOf(configuration, binding);
      // refresh() never rejects; a second touch while one is in flight joins it.
      if (connection !== undefined && this.stale(connection)) void this.refresh(connection);
    }
  }

  private runTick(): void {
    if (this.ticking !== undefined) return;
    this.ticking = this.tick()
      .catch((error: unknown) => {
        this.safeWarn({ error: errorName(error) }, 'upstream pin check failed');
      })
      .finally(() => {
        this.ticking = undefined;
      });
  }

  /**
   * True when the last successful list is older than the freshness window and no attempt was
   * made within it, so a failing upstream is not listed on every call.
   */
  private stale(connection: ConnectionState): boolean {
    const window = Math.min(MAX_FRESHNESS_MS, connection.pinCheckMs);
    const now = this.clock();
    const old = (at: number | undefined): boolean => at === undefined || now - at > window;
    return old(connection.lastSuccessAt) && old(connection.lastAttemptAt);
  }

  /** One list per connection at a time; callers share it. Never rejects. */
  private refresh(connection: ConnectionState): Promise<void> {
    if (connection.inFlight !== undefined) return connection.inFlight;
    connection.lastAttemptAt = this.clock();
    const run = async (): Promise<void> => {
      const catalog = await listCatalog(this.deps.lister, connection.settings, this.clock);
      if (catalog.status === 'listed') this.adopt(connection, catalog);
      await this.evaluate();
    };
    connection.inFlight = run()
      .catch((error: unknown) => {
        this.safeWarn({ connection: connection.settings.id, error: errorName(error) }, 'upstream pin refresh failed');
      })
      .finally(() => {
        connection.inFlight = undefined;
      });
    return connection.inFlight;
  }

  private adopt(connection: ConnectionState, catalog: McpCatalogState & { status: 'listed' }): void {
    connection.catalog = catalog;
    connection.lastSuccessAt = catalog.listedAt;
    const live = new Set(catalog.tools.map((t) => `${t.name}\0${t.hash}`));
    for (const key of connection.validators.keys()) if (!live.has(key)) connection.validators.delete(key);
  }

  private cachedCompile(connection: ConnectionState, binding: McpOperationBinding, schema: Readonly<Record<string, unknown>>): ArgumentValidator {
    // pinStateOf compiles only when the live hash equals the pin, so the pin names the schema.
    const key = `${binding.tool}\0${binding.pin}`;
    const cached = connection.validators.get(key);
    // pinStateOf turns any compile failure into schema_invalid; replay the cached one.
    if (cached instanceof Error) throw cached;
    if (cached !== undefined) return cached;
    let validator: ArgumentValidator;
    try {
      validator = this.compile(schema);
    } catch (error) {
      connection.validators.set(key, error instanceof Error ? error : new Error('schema compile failed'));
      throw error;
    }
    connection.validators.set(key, validator);
    return validator;
  }

  /** The state of an operation's connection under a configuration, seeding from its load-time lists. */
  private connectionOf(configuration: LoadedConfiguration, binding: McpOperationBinding): ConnectionState | undefined {
    const settings = configuration.connectionSettings.get(binding.connection);
    if (settings === undefined) return undefined;
    return this.statesOf(configuration).get(keyOf(settings));
  }

  /** Every `mcp` connection of a configuration, keyed by id and base URL; a configuration seen first seeds them. */
  private statesOf(configuration: LoadedConfiguration): Map<string, ConnectionState> {
    const states = new Map<string, ConnectionState>();
    const first = !this.seeded.has(configuration);
    this.seeded.add(configuration);
    // A request may still hold an older snapshot: only the current configuration (or a new state) sets settings.
    const current = first && configuration === this.deps.configuration();
    for (const [id, catalog] of configuration.mcpCatalogs) {
      const settings = configuration.connectionSettings.get(id);
      if (settings === undefined) continue;
      const key = keyOf(settings);
      let state = this.connections.get(key);
      if (state === undefined) {
        state = {
          settings,
          pinCheckMs: 0,
          catalog: undefined,
          lastSuccessAt: undefined,
          lastAttemptAt: undefined,
          inFlight: undefined,
          validators: new Map(),
        };
        this.connections.set(key, state);
      }
      if (current || state.pinCheckMs === 0) {
        state.settings = settings;
        state.pinCheckMs = (configuration.pinCheckSeconds.get(id) ?? DEFAULT_PIN_CHECK_SECONDS) * 1000;
      }
      if (first) {
        // A load-time list counts as an attempt and a success, unless the monitor already knows a newer one.
        if (catalog.status === 'listed' && (state.lastSuccessAt === undefined || catalog.listedAt > state.lastSuccessAt)) {
          this.adopt(state, catalog);
          state.lastAttemptAt = Math.max(state.lastAttemptAt ?? catalog.listedAt, catalog.listedAt);
        }
      }
      states.set(key, state);
    }
    return states;
  }

  /** Never rejects: a failing evaluation is logged and the chain stays usable for the next one. */
  private evaluate(): Promise<void> {
    const next = this.evaluation
      .then(() => this.evaluateOnce())
      .catch((error: unknown) => {
        this.safeWarn({ error: errorName(error) }, 'upstream pin evaluation failed');
      });
    this.evaluation = next;
    return next;
  }

  /** A warning that cannot throw: a failing logger must not poison the evaluation chain or a refresh. */
  private safeWarn(fields: object, message: string): void {
    try {
      this.deps.logger.warn(fields, message);
    } catch {
      // Nothing left to report to.
    }
  }

  /** Compares each MCP-backed operation of the current configuration with its recorded state and audits changes (R12). */
  private async evaluateOnce(): Promise<void> {
    const configuration = this.deps.configuration();
    const seen = new Set<string>();
    for (const [operationId, binding] of configuration.bindings) {
      if (binding.kind !== 'mcp') continue;
      seen.add(operationId);
      const evaluation = this.view(configuration, operationId);
      if (evaluation === undefined) continue;
      const from = this.recorded.get(operationId) ?? null;
      const to = evaluation.state;
      if (from === to) continue;
      if (from === null && to === 'ok') {
        this.recorded.set(operationId, to);
        continue;
      }
      const details = { connection: binding.connection, tool: binding.tool, from, to, hash: evaluation.liveHash };
      try {
        await this.deps.audit.append({
          id: this.deps.newId(),
          actor: 'system:api',
          action: 'upstream.pin',
          subject: operationId,
          outcome: to === 'ok' ? 'ok' : 'error',
          correlationId: this.deps.newId(),
          details,
        });
      } catch (error) {
        // Not recorded: the next evaluation writes the row again.
        this.deps.logger.warn({ operation: operationId, ...details, error: errorName(error) }, 'upstream pin audit failed');
        continue;
      }
      this.recorded.set(operationId, to);
      const log = to === 'ok' ? this.deps.logger.info.bind(this.deps.logger) : this.deps.logger.warn.bind(this.deps.logger);
      log({ operation: operationId, ...details }, 'upstream pin state changed');
    }
    // An operation that leaves the configuration is first-seen again if it comes back (R12).
    for (const operationId of this.recorded.keys()) if (!seen.has(operationId)) this.recorded.delete(operationId);
  }
}

/** For the opaque plan (R13): one fresh list, no audit, no state kept. */
export async function verifyPinNow(lister: ToolLister, configuration: LoadedConfiguration, operationId: string): Promise<PinEvaluation | undefined> {
  const binding = mcpBinding(configuration, operationId);
  if (binding === undefined) return undefined;
  const settings = configuration.connectionSettings.get(binding.connection);
  if (settings === undefined) return { state: 'unverified', liveHash: null };
  const catalog = await listCatalog(lister, settings, Date.now);
  return pinStateOf(binding, catalog, createSchemaCompiler());
}
