// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The verify-after stage in worker tests (EXE-12): the test configuration with `verify_after` on
 * the write operation's manifest, and a lookup reader that answers the written name only from a
 * given read on, so a test decides at which look the items are confirmed.
 */
import type { LoadedConfiguration } from '@mandate/config';
import type { ManifestVerifyAfter, ReadPage, UpstreamReader } from '@mandate/core';
import { READ_OPERATION, WRITE_OPERATION } from './configuration.js';

/** The verify check's code: the shop does not show the written name yet. */
export const VERIFY_CODE = 'name_not_live';

export interface VerifyTiming {
  readonly afterSeconds: number;
  readonly everySeconds: number;
  readonly timeoutSeconds: number;
}

/**
 * `configuration` with `verify_after` on the write operation: one lookup `shop` of the read
 * operation by target SKU and one check that the shop shows the written name. `batchSize`
 * replaces the manifest's (the verification chunk size).
 */
export function withVerifyAfter(configuration: LoadedConfiguration, timing: VerifyTiming, opts: { batchSize?: number } = {}): LoadedConfiguration {
  const verifyAfter: ManifestVerifyAfter = {
    ...timing,
    lookups: { shop: { operation: READ_OPERATION, idsArg: 'skus', keyField: 'sku', key: { target: true }, fields: ['name'], args: { brand: { arg: 'brand' } } } },
    checks: [{ code: VERIFY_CODE, require: [{ equals: [{ lookup: 'shop', field: 'name' }, { after: 'name' }] }] }],
  };
  return {
    ...configuration,
    policy: {
      ...configuration.policy,
      operations: configuration.policy.operations.map((o) =>
        o.id === WRITE_OPERATION && o.manifest !== undefined
          ? { ...o, manifest: { ...o.manifest, verifyAfter, ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }) } }
          : o,
      ),
    },
  };
}

/**
 * Answers every requested SKU; with the written name `new` from read number `liveFrom` on
 * (1-based; `Infinity`: never), before that with the old one. Counts its reads.
 */
export class LiveFromReader implements UpstreamReader {
  reads = 0;
  constructor(private readonly liveFrom: number) {}

  read(_operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.reads += 1;
    const live = this.reads >= this.liveFrom;
    const skus = Array.isArray(args.skus) ? args.skus.filter((s): s is string => typeof s === 'string') : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: live ? 'new' : `old ${sku}` })), truncated: false });
  }
}
