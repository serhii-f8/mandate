// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { LoadedConfiguration } from '@aiops/config';
import {
  changesetTransitionEvent,
  isOpaque,
  runOpaquePreparation,
  runPreparation,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type UpstreamReader,
  type WorkflowStarter,
} from '@aiops/core';

export interface InProcessStarterDeps {
  readonly configuration: () => LoadedConfiguration;
  readonly repository: ChangeSetRepository;
  readonly readerFor: (configuration: LoadedConfiguration, correlationId: string) => UpstreamReader;
  readonly newId: () => string;
  readonly now: () => Date;
  /** Delay before preparation begins, e.g. to let a bounded wait run out (MCP-7). Default 0. */
  readonly delayMs?: number;
  /** Called with every preparation that threw, when it throws (it is also kept for `settled`). */
  readonly onError?: (error: Error) => void;
}

/**
 * Stands in for the Temporal workflow starter in the api e2e tests: `start` returns at once, as a
 * workflow start does, and the change-set is prepared in this process afterwards, the way the
 * worker's prepare activity does it (same configuration-hash and operation checks, same
 * `runPreparation`, or `runOpaquePreparation` for an opaque operation, actor = requester, the
 * change-set's correlation ID). No Temporal involved.
 */
export class InProcessStarter implements WorkflowStarter {
  private readonly runs = new Set<Promise<void>>();
  private readonly failures: Error[] = [];

  constructor(private readonly deps: InProcessStarterDeps) {}

  start(changesetId: string): Promise<void> {
    const run = new Promise<void>((resolve) => setTimeout(resolve, this.deps.delayMs ?? 0))
      .then(() => this.prepare(changesetId))
      .then(undefined, (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('preparation failed');
        this.failures.push(failure);
        this.deps.onError?.(failure);
      })
      .finally(() => {
        this.runs.delete(run);
      });
    this.runs.add(run);
    return Promise.resolve();
  }

  /** Resolves when every scheduled preparation has ended; rejects with the first one that threw. */
  async settled(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs]);
    const [failure] = this.failures;
    if (failure !== undefined) throw failure;
  }

  private async prepare(changesetId: string): Promise<void> {
    const { repository } = this.deps;
    const configuration = this.deps.configuration();
    const changeset = await repository.get(changesetId);
    if (changeset?.status !== 'preparing') return;
    if (changeset.configHash !== configuration.hash) return this.fail(changeset, 'config_changed');
    const operation = configuration.policy.operations.find((o) => o.id === changeset.operation);
    const actor = {
      actor: changeset.requester,
      ...(changeset.clientId === undefined ? {} : { clientId: changeset.clientId }),
      correlationId: changeset.correlationId,
    };
    // CS-1: an opaque change-set is its one stored call; nothing is read upstream.
    if (operation !== undefined && isOpaque(operation)) {
      await runOpaquePreparation({ repository, newId: this.deps.newId, now: this.deps.now }, { changesetId, operation, ...actor });
      return;
    }
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) return this.fail(changeset, 'operation_unavailable');
    await runPreparation(
      { repository, reader: this.deps.readerFor(configuration, changeset.correlationId), newId: this.deps.newId, now: this.deps.now },
      {
        changesetId,
        operation: { ...operation, manifest },
        readFieldsArg: (id) => configuration.policy.operations.find((o) => o.id === id)?.fieldsArg,
        ...actor,
      },
    );
  }

  private async fail(changeset: ChangeSetRecord, errorCode: string): Promise<void> {
    await this.deps.repository.completePreparation(
      changeset.id,
      { status: 'failed', errorCode },
      changesetTransitionEvent({
        id: this.deps.newId(),
        actor: changeset.requester,
        ...(changeset.clientId === undefined ? {} : { clientId: changeset.clientId }),
        changeset,
        from: 'preparing',
        to: 'failed',
        correlationId: changeset.correlationId,
        details: { errorCode },
      }),
    );
  }
}
