// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * What `changesetWorkflow` leaves in Temporal history (SEC-3, SEC-4): every payload the platform
 * puts there is encrypted, and failure messages are encoded fixed codes.
 */
import { CHANGESET_WORKFLOW, createPayloadCodec, parseTemporalKeys, WAKE_SIGNAL } from '@mandate/temporal';
import type { ChangeItemRecord } from '@mandate/core';
import { ScriptedWriter } from '@mandate/testing';
import type { WorkflowHandle } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared } from '../support/changesets.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';
import { startInfrastructure, startTestWorker, type Infra } from '../support/harness.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;
interface StoredPayload {
  readonly metadata?: Record<string, Uint8Array> | null;
  readonly data?: Uint8Array | null;
}
interface PayloadList {
  readonly payloads?: StoredPayload[] | null;
}

/** Runs one change-set of `items` items to its end and returns its history. */
async function runToEnd(
  writer: ScriptedWriter,
  items: number,
  opts: { itemFor?: (targetId: string) => ChangeItemRecord; settings?: { itemsPerRun: number } } = {},
): Promise<{ id: string; status: string; history: History; runs: History[] }> {
  const cs = await createPrepared(infra.repository, items, { execute: {}, ...(opts.itemFor === undefined ? {} : { itemFor: opts.itemFor }) });
  const worker = await startTestWorker(infra, { writer, ...(opts.settings === undefined ? {} : { settings: opts.settings }) });
  try {
    const handle = await infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
      workflowId: cs.id,
      taskQueue: worker.taskQueue,
      args: [{ changesetId: cs.id }],
      signal: WAKE_SIGNAL,
      signalArgs: [],
    });
    const { status } = await handle.result();
    // The handle follows the chain to the last run; every run's history is wanted too (continue-as-new input).
    const runs: History[] = [];
    let runId: string | undefined = handle.signaledRunId;
    while (runId !== undefined) {
      const h: History = await infra.client.workflow.getHandle(cs.id, runId).fetchHistory();
      runs.push(h);
      runId = (h.events ?? []).map((e) => e.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId).find((r) => r !== undefined && r !== null && r !== '') ?? undefined;
    }
    return { id: cs.id, status, history: await handle.fetchHistory(), runs };
  } finally {
    await worker.stop();
  }
}

/** Payloads of the started input, activity inputs and results, signal inputs, failure attributes and the result. */
function payloadsOf(history: History): StoredPayload[] {
  const lists: (PayloadList | null | undefined)[] = [];
  const single: (StoredPayload | null | undefined)[] = [];
  for (const e of history.events ?? []) {
    lists.push(
      e.workflowExecutionStartedEventAttributes?.input,
      e.activityTaskScheduledEventAttributes?.input,
      e.activityTaskCompletedEventAttributes?.result,
      e.workflowExecutionSignaledEventAttributes?.input,
      e.workflowExecutionCompletedEventAttributes?.result,
      e.workflowExecutionContinuedAsNewEventAttributes?.input,
    );
    single.push(e.activityTaskFailedEventAttributes?.failure?.encodedAttributes, e.activityTaskFailedEventAttributes?.failure?.cause?.encodedAttributes);
  }
  return [...lists.flatMap((l) => l?.payloads ?? []), ...single.filter((p): p is StoredPayload => p !== null && p !== undefined)];
}

function metadata(p: StoredPayload, key: string): string | undefined {
  const value = p.metadata?.[key];
  return value === undefined ? undefined : Buffer.from(value).toString('utf8');
}

describe('changesetWorkflow history', () => {
  it('SEC-4 SEC-3 history carries no plaintext change-set ID in payloads and no plaintext failure message', async () => {
    const completed = await runToEnd(new ScriptedWriter(), 3);
    expect(completed.status).toBe('completed');
    const failingWriter = new ScriptedWriter();
    failingWriter.throwAt(0);
    const failed = await runToEnd(failingWriter, 2);
    expect(failed.status).toBe('failed');
    expect(failingWriter.calls).toBeGreaterThan(1);

    for (const run of [completed, failed]) {
      const payloads = payloadsOf(run.history);
      // Started input, at least one activity's input and result, and the workflow result.
      expect(payloads.length).toBeGreaterThanOrEqual(4);
      for (const p of payloads) expect(metadata(p, 'encoding')).toBe('binary/encrypted');
      for (const p of payloads) {
        const data = Buffer.from(p.data ?? new Uint8Array());
        expect(data.includes(run.id)).toBe(false);
        expect(data.includes('scripted writer failure')).toBe(false);
      }

      const json = historyToJSON(run.history);
      expect(json).not.toContain('scripted writer failure');
      expect(json).not.toContain(Buffer.from(run.id).toString('base64'));
    }
    // The failing run did record an activity failure, encoded.
    const failures = (failed.history.events ?? []).filter((e) => e.activityTaskFailedEventAttributes !== null && e.activityTaskFailedEventAttributes !== undefined);
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(f.activityTaskFailedEventAttributes?.failure?.encodedAttributes).toBeTruthy();
  }, 60_000);

  it('EXE-2 workflow input, signals and activity arguments carry identifiers and counters only', async () => {
    const marker = 'ITEM-VALUE-MARKER';
    const targetOf = (targetId: string): string => `TARGET-${targetId}-XYZZY`;
    const itemFor = (targetId: string): ChangeItemRecord => ({
      targetId: targetOf(targetId),
      status: 'pending',
      before: { name: `${marker}-before-${targetId}` },
      after: { name: `${marker}-after-${targetId}` },
    });
    // itemsPerRun 2 with batches of 2 forces continue-as-new, so its input is checked as well.
    const run = await runToEnd(new ScriptedWriter(), 5, { itemFor, settings: { itemsPerRun: 2 } });
    expect(run.status).toBe('completed');

    const codec = createPayloadCodec(parseTemporalKeys(TEST_TEMPORAL_KEYS));
    const decode = async (list: PayloadList | null | undefined): Promise<unknown[]> => {
      const stored = (list?.payloads ?? []).map((p) => ({ metadata: p.metadata ?? null, data: p.data ?? null }));
      return (await codec.decode(stored)).map((p) => defaultPayloadConverter.fromPayload(p));
    };
    const started: unknown[][] = [];
    const signals: unknown[][] = [];
    const continued: unknown[][] = [];
    const activities: { type: string; args: unknown[] }[] = [];
    for (const e of run.runs.flatMap((h) => h.events ?? [])) {
      const s = e.workflowExecutionStartedEventAttributes;
      if (s) started.push(await decode(s.input));
      const sig = e.workflowExecutionSignaledEventAttributes;
      if (sig) signals.push(await decode(sig.input));
      const c = e.workflowExecutionContinuedAsNewEventAttributes;
      if (c) continued.push(await decode(c.input));
      const a = e.activityTaskScheduledEventAttributes;
      if (a) activities.push({ type: a.activityType?.name ?? '?', args: await decode(a.input) });
    }
    expect(started.length).toBeGreaterThan(0);
    expect(continued.length).toBeGreaterThan(0);
    expect(activities.length).toBeGreaterThan(0);
    expect(activities.some((a) => a.type === 'executeBatch')).toBe(true);

    const everything = JSON.stringify([started, signals, continued, activities]);
    expect(everything).toContain(run.id); // the decoder works and the ID is what is carried
    expect(everything).not.toContain(marker);
    expect(everything).not.toContain('XYZZY');
    expect(everything).not.toContain('before');
    expect(everything).not.toContain('after');
    expect(everything).not.toContain('"new"');

    // Activity arguments: the change-set ID first, then only scalars (batch number, flags, outcome codes).
    for (const a of activities) {
      const [id, ...rest] = a.args;
      expect(id).toBe(run.id);
      for (const arg of rest) {
        const flat = typeof arg === 'object' && arg !== null ? Object.values(arg) : [arg];
        for (const v of flat) expect(['string', 'number', 'boolean']).toContain(typeof v);
      }
      if (a.type === 'executeBatch') expect(typeof rest[0]).toBe('number');
    }
    // Workflow input and continue-as-new input: the change-set ID plus a resume record of counters and flags.
    for (const input of [...started, ...continued]) {
      expect(input).toHaveLength(1);
      const arg = input[0] as { changesetId: string; resume?: Record<string, unknown> };
      expect(arg.changesetId).toBe(run.id);
      expect(Object.keys(arg).sort()).toEqual(arg.resume === undefined ? ['changesetId'] : ['changesetId', 'resume']);
      const leaves = (v: unknown): unknown[] => (typeof v === 'object' && v !== null ? Object.values(v).flatMap(leaves) : [v]);
      for (const v of leaves(arg.resume)) expect(['undefined', 'number', 'boolean']).toContain(typeof v);
    }
    for (const s of signals) expect(s).toEqual([]);
  }, 90_000);
});
