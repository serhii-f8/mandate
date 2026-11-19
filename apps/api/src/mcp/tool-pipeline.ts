/**
 * `tools/list` and `tools/call` as `api` owns them (ADR 0016): every request,
 * including the ones rejected before anything runs, passes through code that
 * audits it. Order of a call: lookup in the caller's own list (MCP-2) →
 * argument validation (MCP-3) → policy decision, audited (POL-8) → run (SEC-1).
 */
import { ProtocolError, ProtocolErrorCode, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { LoadedConfiguration } from '@aiops/config';
import {
  allowingRole,
  createPolicyEngine,
  resolveRoles,
  toolCallAuditEvent,
  type AuditLog,
  type Caller,
  type DenyReason,
  type OperationDefinition,
  type OperationInvoker,
  type PolicyDecision,
  type PolicyEngine,
  type RateCounter,
} from '@aiops/core';
import { withPageLink } from '../changesets/links.js';
import { toCallToolResult } from '../changesets/results.js';
import { createTaskResult, isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import { AUDIT_UNAVAILABLE, auditedRun } from './audited-tool.js';
import { NO_TELEMETRY, UNKNOWN_TOOL, type PipelineTelemetry, type ToolCallOutcome } from './pipeline-telemetry.js';
import { deniedResult, recordDecision } from './policy-answers.js';
import type { BuiltinTool } from './tool-catalog.js';
import type { WidgetCatalog } from './widget-bundles.js';

/** One configuration and its engine, taken once per HTTP request. */
export interface Snapshot {
  readonly configuration: LoadedConfiguration;
  readonly engine: PolicyEngine;
}

export interface PipelineDeps {
  readonly snapshot: () => Snapshot;
  readonly builtins: readonly BuiltinTool[];
  /**
   * The invoker for one call, bound to the configuration snapshot its lookup, validation
   * and policy decision used, so a reload in flight cannot change what runs (SEC-1).
   */
  readonly invokerFor: (configuration: LoadedConfiguration, correlationId: string) => OperationInvoker;
  readonly audit: AuditLog;
  readonly newId: () => string;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Counts calls per (user, role) and UTC minute (POL-4, NFR-3: shared across instances). */
  readonly rateCounter: RateCounter;
  /** Wall-clock time, for the rate-limit window only. */
  readonly wallClock: () => Date;
  /** The widget bundles served as UI resources and linked from tools (MCP-5, MCP-6). */
  readonly widgets: WidgetCatalog;
  /** `AIOPS_PUBLIC_URL`, the base of the change-set page links (MCP-6). */
  readonly publicUrl: URL;
  /** Spans and counters of tool calls (NFR-11, NFR-12); default `NO_TELEMETRY`. */
  readonly telemetry?: PipelineTelemetry;
}

/** The start of the UTC minute containing `now`. */
export function minuteWindow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

const RATE_LIMIT_UNAVAILABLE: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Rate limit check unavailable; the call was not completed.' }],
};

export interface PipelineRequest {
  readonly caller: Caller;
  readonly correlationId: string;
  readonly declaredClientName?: string;
  readonly snapshot: Snapshot;
  /** The request declared the Tasks extension (MCP-7, MCP-1). */
  readonly tasks: boolean;
}

const engines = new WeakMap<LoadedConfiguration, PolicyEngine>();

/** The engine for a configuration, built once per configuration (NFR-6). */
export function snapshotOf(configuration: LoadedConfiguration): Snapshot {
  let engine = engines.get(configuration);
  if (engine === undefined) {
    engine = createPolicyEngine(configuration.policy);
    engines.set(configuration, engine);
  }
  return { configuration, engine };
}

/** Write and destructive operations with a manifest prepare a change-set, so they link the change-set widget (MCP-5). */
export function linksChangeset(op: OperationDefinition): boolean {
  return (op.risk === 'write' || op.risk === 'destructive') && op.manifest !== undefined;
}

/** `_meta` with the MCP Apps linkage: the nested form and the flat legacy key (MCP-5). */
export function uiMeta(existing: Readonly<Record<string, unknown>> | undefined, resourceUri: string): Record<string, unknown> {
  return { ...existing, ui: { ...(existing?.ui as object | undefined), resourceUri }, 'ui/resourceUri': resourceUri };
}

/** Operations are published under their tool name (MCP-9); policy and audit use the operation ID. */
function operationTool(op: OperationDefinition, widgets: WidgetCatalog): Tool {
  const uri = linksChangeset(op) ? widgets.uriFor('changeset') : undefined;
  return {
    name: op.toolName,
    ...(op.title === undefined ? {} : { title: op.title }),
    description: op.description,
    inputSchema: op.inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: op.risk === 'read', destructiveHint: op.risk === 'destructive' },
    ...(uri === undefined ? {} : { _meta: uiMeta(undefined, uri) }),
  };
}

function builtinTool(tool: BuiltinTool, widgets: WidgetCatalog): Tool {
  const uri = tool.widget === undefined ? undefined : widgets.uriFor(tool.widget);
  const meta = uri === undefined ? tool.meta : uiMeta(tool.meta, uri);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnlyHint ?? true },
    ...(meta === undefined ? {} : { _meta: { ...meta } }),
  };
}

/** The built-ins this caller sees under this configuration (MCP-2). */
function visibleBuiltins(builtins: readonly BuiltinTool[], caller: Caller, configuration: LoadedConfiguration): BuiltinTool[] {
  return builtins.filter((t) => t.visibleTo?.(caller, configuration) ?? true);
}

export async function listTools(deps: PipelineDeps, req: PipelineRequest): Promise<Tool[]> {
  const granted = req.snapshot.engine.grantedOperations(req.caller);
  const builtins = visibleBuiltins(deps.builtins, req.caller, req.snapshot.configuration);
  const tools = [...builtins.map((t) => builtinTool(t, deps.widgets)), ...granted.map((op) => operationTool(op, deps.widgets))];
  try {
    await deps.audit.append({
      id: deps.newId(),
      actor: req.caller.subject,
      ...(req.caller.clientId === undefined ? {} : { clientId: req.caller.clientId }),
      action: 'tools.list',
      outcome: 'ok',
      correlationId: req.correlationId,
      details: { count: tools.length },
    });
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'Audit unavailable; the request was not completed.');
  }
  return tools;
}

/**
 * The metric label and span attribute of a called name (NFR-12, SEC-3): the name itself when it is
 * a built-in (visible to the caller or not) or a configured operation tool of the snapshot,
 * `_unknown` otherwise, so a caller cannot grow the label set. Not taken from the caller's grants.
 */
function toolLabel(builtins: readonly BuiltinTool[], configuration: LoadedConfiguration, name: string): string {
  const known = builtins.some((t) => t.name === name) || configuration.policy.operations.some((op) => op.toolName === name);
  return known ? name : UNKNOWN_TOOL;
}

/** How one call ended, for the counters: an answer, or the lookup error that is thrown after counting. */
type CallEnd =
  | { readonly answer: ToolAnswer; readonly outcome: ToolCallOutcome; readonly denial?: DenyReason }
  | { readonly thrown: ProtocolError; readonly denial: DenyReason };

function answered(answer: ToolAnswer): CallEnd {
  // A task handle is a successful answer (MCP-7); AUDIT_UNAVAILABLE and failures carry isError.
  return { answer, outcome: !isTaskAnswer(answer) && answer.isError === true ? 'error' : 'ok' };
}

export async function callTool(deps: PipelineDeps, req: PipelineRequest, name: string, rawArgs: unknown): Promise<ToolAnswer> {
  const telemetry = deps.telemetry ?? NO_TELEMETRY;
  const tool = toolLabel(deps.builtins, req.snapshot.configuration, name);
  return telemetry.toolCall(tool, req.correlationId, async () => {
    let end: CallEnd;
    try {
      end = await runCall(deps, req, name, rawArgs);
    } catch (error) {
      telemetry.countToolCall(tool, 'error');
      throw error;
    }
    if (end.denial !== undefined) telemetry.countDenial(end.denial);
    if ('thrown' in end) {
      telemetry.countToolCall(tool, 'denied');
      throw end.thrown;
    }
    telemetry.countToolCall(tool, end.outcome);
    return end.answer;
  });
}

async function runCall(deps: PipelineDeps, req: PipelineRequest, name: string, rawArgs: unknown): Promise<CallEnd> {
  const { configuration, engine } = req.snapshot;
  // A built-in the caller does not see is looked up like any unknown name.
  const builtin = visibleBuiltins(deps.builtins, req.caller, configuration).find((t) => t.name === name);
  const operation = builtin === undefined ? engine.grantedOperations(req.caller).find((op) => op.toolName === name) : undefined;

  // 1. Lookup (MCP-2): unknown, not granted and not visible get the same answer, so the list does not leak.
  if (builtin === undefined && operation === undefined) {
    const exists = configuration.policy.operations.some((op) => op.toolName === name);
    const reason: DenyReason = exists ? 'no_grant' : 'unknown_tool';
    await recordDecision(deps, req, name, {
      effect: 'deny',
      rule: 'default-deny',
      reason,
      roles: resolveRoles(req.caller.groups, configuration.policy.roleMapping),
    });
    return { thrown: new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`), denial: reason };
  }

  const runDeps = {
    audit: deps.audit,
    caller: req.caller,
    correlationId: req.correlationId,
    newId: deps.newId,
    now: deps.now,
    ...(req.declaredClientName === undefined ? {} : { declaredClientName: req.declaredClientName }),
  };

  // 2. Arguments (MCP-3), before any policy or upstream call.
  const args = rawArgs ?? {};
  const check = builtin !== undefined ? builtin.validate(args) : operation === undefined ? undefined : configuration.validators.get(operation.id)?.(args);
  // MCP-9: operation rows record the operation ID behind the called tool name.
  const operationDetails = operation === undefined ? {} : { details: { operation: operation.id } };
  if (check?.ok !== true) {
    const message = check === undefined ? 'no input schema' : check.message;
    const invalid: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: `Input validation error: Invalid arguments for tool ${name}: ${message}` }],
    };
    // Nothing ran, so an audit failure does not change the answer.
    await deps.audit
      .append(
        toolCallAuditEvent({
          id: deps.newId(),
          caller: req.caller,
          tool: name,
          outcome: 'error',
          correlationId: req.correlationId,
          durationMs: 0,
          errorCode: 'invalid_arguments',
          ...operationDetails,
          ...(req.declaredClientName === undefined ? {} : { declaredClientName: req.declaredClientName }),
        }),
      )
      .catch(() => undefined);
    return { answer: invalid, outcome: 'error' };
  }
  // The schema root is `type: object`, so validated arguments are an object.
  const validArgs = args as Readonly<Record<string, unknown>>;

  // 3. Decision (POL-1..3), audited before anything runs (POL-8).
  let decision: PolicyDecision =
    builtin !== undefined
      ? { effect: 'allow', rule: 'builtin', roles: resolveRoles(req.caller.groups, configuration.policy.roleMapping) }
      : // Step 1 returned unless a built-in or a granted operation was found.
        engine.evaluate({ caller: req.caller, operationId: operation?.id ?? name, args: validArgs });
  // POL-4: calls_per_minute per (user, role). Over the limit the deny replaces the allow, so the
  // call still writes exactly one policy.decision row (POL-8). Built-ins are not counted.
  if (builtin === undefined && decision.effect === 'allow') {
    const role = allowingRole(decision.rule);
    const limit = role === undefined ? undefined : configuration.limits.get(role)?.calls_per_minute;
    if (role !== undefined && limit !== undefined) {
      try {
        const count = await deps.rateCounter.hit(`${req.caller.subject}|${role}`, minuteWindow(deps.wallClock()));
        if (count > limit) {
          decision = { effect: 'deny', rule: `role:${role}/limit:calls_per_minute`, reason: 'limit_exceeded', detail: 'calls_per_minute', roles: decision.roles };
        }
      } catch {
        // Fail closed; the error may name the caller, so nothing of it is kept (SEC-3). One
        // best-effort deny row keeps POL-8 (exactly one decision per call).
        await recordDecision(
          deps,
          req,
          name,
          { effect: 'deny', rule: `role:${role}/limit:calls_per_minute`, reason: 'limit_exceeded', detail: 'calls_per_minute_unavailable', roles: decision.roles },
          operation === undefined ? {} : { operation: operation.id },
        );
        return { answer: RATE_LIMIT_UNAVAILABLE, outcome: 'denied', denial: 'limit_exceeded' };
      }
    }
  }
  const recorded = await recordDecision(deps, req, name, decision, operation === undefined ? {} : { operation: operation.id });
  // deniedResult answers a deny without a reason as no_grant; the counter does the same.
  if (decision.effect === 'deny') return { answer: deniedResult(decision), outcome: 'denied', denial: decision.reason ?? 'no_grant' };
  if (!recorded) return { answer: AUDIT_UNAVAILABLE, outcome: 'error' };

  // 4. Run (SEC-1: only after an allow decision of this request is on record).
  const answer = await auditedRun(
    name,
    async (report) => {
      if (builtin !== undefined) {
        // A change-set ID is an identifier, not argument content, so it may be audited.
        if (typeof validArgs.changeset_id === 'string') report({ changesetId: validArgs.changeset_id });
        const answer = await builtin.handler(validArgs, { caller: req.caller, snapshot: req.snapshot, correlationId: req.correlationId, tasks: req.tasks, report });
        // Never a task for a request that did not declare the extension, whoever built it (MCP-1).
        if (isTaskAnswer(answer) && !req.tasks) throw new Error('task answer for a request without the Tasks declaration');
        return answer;
      }
      // Step 1 returned unless a built-in or a granted operation was found.
      if (operation === undefined) throw new Error('no operation after lookup');
      report({ operation: operation.id });
      const result = await deps.invokerFor(configuration, req.correlationId).invoke({ operation, args: validArgs, caller: req.caller, asTask: req.tasks, report });
      // The operation ID stays authoritative over whatever the invoker reports.
      if (result.auditDetails !== undefined) report({ ...result.auditDetails, operation: operation.id });
      if (result.task !== undefined) {
        // A task for a request that did not declare the extension is a server bug; it must not reach the client (MCP-1).
        if (!req.tasks) throw new Error('task created for a request without the Tasks declaration');
        report({ taskId: result.task.taskId });
        return createTaskResult(result.task);
      }
      return toCallToolResult(result);
    },
    runDeps,
  );
  // MCP-6: the tools linked to a widget answer with the page link too, bundle or not; added after
  // the tool.call row is written, so the audit never holds the URL.
  const linked = builtin !== undefined ? builtin.widget !== undefined : operation !== undefined && linksChangeset(operation);
  return answered(linked ? withPageLink(answer, deps.publicUrl) : answer);
}
