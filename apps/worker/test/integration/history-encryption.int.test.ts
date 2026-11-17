/**
 * What `changesetWorkflow` leaves in Temporal history (SEC-3, SEC-4): every payload the platform
 * puts there is encrypted, and failure messages are encoded fixed codes.
 */
import { CHANGESET_WORKFLOW, WAKE_SIGNAL } from '@aiops/temporal';
import { ScriptedWriter } from '@aiops/testing';
import type { WorkflowHandle } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared } from '../support/changesets.js';
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
async function runToEnd(writer: ScriptedWriter, items: number): Promise<{ id: string; status: string; history: History }> {
  const cs = await createPrepared(infra.repository, items, { execute: {} });
  const worker = await startTestWorker(infra, { writer });
  try {
    const handle = await infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
      workflowId: cs.id,
      taskQueue: worker.taskQueue,
      args: [{ changesetId: cs.id }],
      signal: WAKE_SIGNAL,
      signalArgs: [],
    });
    const { status } = await handle.result();
    return { id: cs.id, status, history: await handle.fetchHistory() };
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
});
