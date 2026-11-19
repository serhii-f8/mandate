import { describe, expect, it } from 'vitest';
import type { ManifestDefinition, RiskClass } from '../policy-model.js';
import { OPAQUE_TARGET_ID, changesetKind, isOpaque } from './opaque.js';

const MANIFEST: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'catalog.get_products', idsArg: 'skus', args: {} },
  batchSize: 50,
  maxTargets: 500,
  rollback: { strategy: 'none' },
};

type Row = [string, RiskClass, ManifestDefinition | undefined, boolean];

const rows: Row[] = [
  ['write_opaque without manifest', 'write_opaque', undefined, true],
  ['destructive without manifest', 'destructive', undefined, true],
  ['destructive with manifest', 'destructive', MANIFEST, false],
  ['write with manifest', 'write', MANIFEST, false],
  ['read', 'read', undefined, false],
];

describe('POL-5 opaque operations', () => {
  it.each(rows)('POL-5 %s', (_name, risk, manifest, expected) => {
    const op = { risk, ...(manifest === undefined ? {} : { manifest }) };
    expect(isOpaque(op)).toBe(expected);
    expect(changesetKind(op)).toBe(expected ? 'opaque' : 'diff');
  });

  it('POL-5 an operation missing from the snapshot is a diff change-set', () => {
    expect(changesetKind(undefined)).toBe('diff');
  });

  it('POL-5 the one item of an opaque change-set is named call', () => {
    expect(OPAQUE_TARGET_ID).toBe('call');
  });
});
