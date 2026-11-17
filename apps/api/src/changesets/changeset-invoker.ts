/**
 * A call of an allowed `write` operation with a manifest prepares a change-set (design
 * §4.1, CS-1): current state is read, items are stored, the hash is computed, and nothing
 * is written upstream. The result is the counts-only summary of design §6.1 (MCP-4, SEC-5).
 */
import type { LoadedConfiguration } from '@aiops/config';
import {
  encodeCursor,
  prepareChangeSet,
  preparationErrorResult,
  preparedResult,
  type ChangeSetRepository,
  type InvocationRequest,
  type InvocationResult,
  type OperationInvoker,
  type UpstreamReader,
} from '@aiops/core';
import { riskNotSupportedResult } from '../upstream/risk-not-supported.js';

const FIRST_ITEMS = 20;

export interface ChangeSetInvokerDeps {
  /** The request's configuration snapshot, the one its policy decision used (SEC-1). */
  readonly configuration: LoadedConfiguration;
  readonly repository: ChangeSetRepository;
  /** Bound to the same snapshot and correlation ID. */
  readonly reader: UpstreamReader;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly correlationId: string;
}

export class ChangeSetInvoker implements OperationInvoker {
  constructor(private readonly deps: ChangeSetInvokerDeps) {}

  async invoke({ operation, args, caller }: InvocationRequest): Promise<InvocationResult> {
    const { manifest } = operation;
    if (operation.risk !== 'write' || manifest === undefined) return riskNotSupportedResult(operation);
    const { configuration } = this.deps;
    const base = { operation: operation.id, connection: operation.connection };

    const outcome = await prepareChangeSet(
      { repository: this.deps.repository, reader: this.deps.reader, newId: this.deps.newId, now: this.deps.now },
      {
        operation: { ...operation, manifest },
        args,
        caller,
        correlationId: this.deps.correlationId,
        configHash: configuration.hash,
        expireAfterHours: configuration.changesets.expireAfterHours,
        readFieldsArg: (id) => configuration.policy.operations.find((o) => o.id === id)?.fieldsArg,
      },
    );

    if (!outcome.ok) {
      return {
        ...preparationErrorResult(operation.id, outcome.code, outcome.changesetId),
        auditDetails: { ...base, ...(outcome.changesetId === undefined ? {} : { changesetId: outcome.changesetId }), errorCode: outcome.code },
      };
    }
    const { changeset, firstItems } = outcome;
    const last = firstItems.at(-1);
    const nextCursor = firstItems.length === FIRST_ITEMS && changeset.stats.total > FIRST_ITEMS && last !== undefined ? encodeCursor(last.targetId) : undefined;
    const excluded = Object.values(changeset.stats.excluded).reduce((sum, n) => sum + n, 0);
    return {
      ...preparedResult(changeset, firstItems, nextCursor),
      auditDetails: { ...base, changesetId: changeset.id, included: changeset.stats.included, excluded },
    };
  }
}
