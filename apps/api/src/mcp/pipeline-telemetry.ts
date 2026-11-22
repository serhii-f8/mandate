// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Spans and counters of the MCP tool path (NFR-11, NFR-12). Labels and attributes carry only a
 * bounded tool name, an outcome, a deny reason and the correlation ID: never an argument value,
 * a user or an error message (SEC-3).
 */
import { SpanKind, SpanStatusCode, type Meter, type Tracer } from '@opentelemetry/api';
import type { DenyReason } from '@mandate/core';

export type ToolCallOutcome = 'ok' | 'error' | 'denied';

export interface PipelineTelemetry {
  /** Runs one tools/call inside an `mcp.tool_call` span with `mandate.tool` and `mandate.correlation_id`. */
  toolCall<T>(tool: string, correlationId: string, run: () => Promise<T>): Promise<T>;
  /** One per tools/call; `tool` is already bounded. */
  countToolCall(tool: string, outcome: ToolCallOutcome): void;
  countDenial(reason: DenyReason): void;
}

/** The tool label: the name when it is a built-in or a configured operation tool of the snapshot, `_unknown` otherwise. */
export const UNKNOWN_TOOL = '_unknown';

export const NO_TELEMETRY: PipelineTelemetry = {
  toolCall: (_tool, _correlationId, run) => run(),
  countToolCall: () => undefined,
  countDenial: () => undefined,
};

export function createPipelineTelemetry(deps: { readonly tracer: Tracer; readonly meter: Meter }): PipelineTelemetry {
  const calls = deps.meter.createCounter('mandate_tool_calls_total', { description: 'MCP tool calls per tool and outcome.' });
  const denials = deps.meter.createCounter('mandate_policy_denials_total', { description: 'Policy denials per reason.' });
  return {
    toolCall: (tool, correlationId, run) =>
      deps.tracer.startActiveSpan(
        'mcp.tool_call',
        { kind: SpanKind.INTERNAL, attributes: { 'mandate.tool': tool, 'mandate.correlation_id': correlationId } },
        async (span) => {
          try {
            return await run();
          } catch (error) {
            // Status only: the error's message may carry argument or upstream content (SEC-3).
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      ),
    countToolCall: (tool, outcome) => {
      calls.add(1, { tool, outcome });
    },
    countDenial: (reason) => {
      denials.add(1, { reason });
    },
  };
}
