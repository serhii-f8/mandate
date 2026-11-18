import { describe, expect, expectTypeOf, it } from 'vitest';
import { CONNECTOR_SDK_VERSION, CREDENTIAL_SCHEMES, type BulkMapping, type ReadErrorCode, type UpstreamMapping, type WriteErrorCode } from './index.js';

describe('NFR-18 connector SDK 0.4.0 is additive', () => {
  it('NFR-18 reports version 0.4.0', () => {
    expect(CONNECTOR_SDK_VERSION).toBe('0.4.0');
  });
  it('NFR-18 SEC-2 webhook_url is appended to the credential schemes, old order kept', () => {
    expect(CREDENTIAL_SCHEMES).toEqual(['bearer', 'api_key', 'basic', 'oauth_client_credentials', 'webhook_url']);
  });
  it('NFR-18 OPS-6 UpstreamMapping.bulk is optional and WriteErrorCode extends ReadErrorCode', () => {
    expectTypeOf<UpstreamMapping['bulk']>().toEqualTypeOf<BulkMapping | undefined>();
    expectTypeOf<ReadErrorCode>().toExtend<WriteErrorCode>();
    expectTypeOf<'rejected'>().toExtend<WriteErrorCode>();
  });
});
