import { describe, expect, expectTypeOf, it } from 'vitest';
import { CONNECTOR_SDK_VERSION, type BulkMapping, type ReadErrorCode, type UpstreamMapping, type WriteErrorCode } from './index.js';

describe('NFR-18 connector SDK 0.3.0 is additive', () => {
  it('NFR-18 reports version 0.3.0', () => {
    expect(CONNECTOR_SDK_VERSION).toBe('0.3.0');
  });
  it('NFR-18 OPS-6 UpstreamMapping.bulk is optional and WriteErrorCode extends ReadErrorCode', () => {
    expectTypeOf<UpstreamMapping['bulk']>().toEqualTypeOf<BulkMapping | undefined>();
    expectTypeOf<ReadErrorCode>().toExtend<WriteErrorCode>();
    expectTypeOf<'rejected'>().toExtend<WriteErrorCode>();
  });
});
