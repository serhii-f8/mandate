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
  type OperationDefinition,
  type OperationInvoker,
  type PolicyDecision,
  type PolicyEngine,
  type RateCounter,
} from '@aiops/core';
import { toCallToolResult } from '../changesets/results.js';
import { createTaskResult, isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import { AUDIT_UNAVAILABLE, auditedRun } from './audited-tool.js';
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

/** Operations are published under their tool name (MCP-9); policy and audit use the operation ID. */
function operationTool(op: OperationDefinition): Tool {
  return {
    name: op.toolName,
    ...(op.title === undefined ? {} : { title: op.title }),
    description: op.description,
    inputSchema: op.inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: op.risk === 'read', destructiveHint: op.risk === 'destructive' },
  };
}

function builtinTool(tool: BuiltinTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnlyHint ?? true },
    ...(tool.meta === undefined ? {} : { _meta: { ...tool.meta } }),
  };
}

/** The built-ins this caller sees under this configuration (MCP-2). */
function visibleBuiltins(builtins: readonly BuiltinTool[], caller: Caller, configuration: LoadedConfiguration): BuiltinTool[] {
  return builtins.filter((t) => t.visibleTo?.(caller, configuration) ?? true);
}

export async function listTools(deps: PipelineDeps, req: PipelineRequest): Promise<Tool[]> {
  const granted = req.snapshot.engine.grantedOperations(req.caller);
  const builtins = visibleBuiltins(deps.builtins, req.caller, req.snapshot.configuration);
  const tools = [...builtins.map(builtinTool), ...granted.map(operationTool)];
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

export async function callTool(deps: PipelineDeps, req: PipelineRequest, name: string, rawArgs: unknown): Promise<ToolAnswer> {
  const { configuration, engine } = req.snapshot;
  // A built-in the caller does not see is looked up like any unknown name.
  const builtin = visibleBuiltins(deps.builtins, req.caller, configuration).find((t) => t.name === name);
  const operation = builtin === undefined ? engine.grantedOperations(req.caller).find((op) => op.toolName === name) : undefined;

  // 1. Lookup (MCP-2): unknown, not granted and not visible get the same answer, so the list does not leak.
  if (builtin === undefined && operation === undefined) {
    const exists = configuration.policy.operations.some((op) => op.toolName === name);
    await recordDecision(deps, req, name, {
      effect: 'deny',
      rule: 'default-deny',
      reason: exists ? 'no_grant' : 'unknown_tool',
      roles: resolveRoles(req.caller.groups, configuration.policy.roleMapping),
    });
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
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
    return invalid;
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
        return RATE_LIMIT_UNAVAILABLE;
      }
    }
  }
  const recorded = await recordDecision(deps, req, name, decision, operation === undefined ? {} : { operation: operation.id });
  if (decision.effect === 'deny') return deniedResult(decision);
  if (!recorded) return AUDIT_UNAVAILABLE;

  // 4. Run (SEC-1: only after an allow decision of this request is on record).
  return auditedRun(
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
}
