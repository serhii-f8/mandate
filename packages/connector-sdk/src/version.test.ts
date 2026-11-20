import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONNECTOR_SDK_VERSION,
  CREDENTIAL_SCHEMES,
  type BulkMapping,
  type CallOutcome,
  type CodeAdapter,
  type CodeArgs,
  type CodeCallOperation,
  type CodeCallOutcome,
  type CodeCallResult,
  type CodeContext,
  type CodeHttpClient,
  type CodeHttpRequest,
  type CodeHttpResponse,
  type CodeOperation,
  type CodeReadOperation,
  type CodeReadResult,
  type CodeWriteContext,
  type CodeWriteOperation,
  type CodeWriteOutcome,
  type PresetModule,
  type RecordOutcome,
  type RecordSendOutcome,
  type RecordWriteAdapter,
  type TemplateValue,
  type WriteRecord,
  parsePresetModule,
  type CallTarget,
  type ConnectionSettings,
  type ReadErrorCode,
  type ToolListOutcome,
  type RequestAttempt,
  type RequestInstrumentation,
  type UpstreamMapping,
  type UpstreamResolver,
  type WriteAdapter,
  type WriteErrorCode,
} from './index.js';

describe('NFR-18 connector SDK 0.6.0 is additive', () => {
  it('NFR-18 reports version 0.6.0', () => {
    expect(CONNECTOR_SDK_VERSION).toBe('0.6.0');
  });
  it('NFR-18 SEC-2 webhook_url is appended to the credential schemes, old order kept', () => {
    expect(CREDENTIAL_SCHEMES).toEqual(['bearer', 'api_key', 'basic', 'oauth_client_credentials', 'webhook_url']);
  });
  it('NFR-18 OPS-6 UpstreamMapping.bulk is optional and WriteErrorCode extends ReadErrorCode', () => {
    expectTypeOf<UpstreamMapping['bulk']>().toEqualTypeOf<BulkMapping | undefined>();
    expectTypeOf<ReadErrorCode>().toExtend<WriteErrorCode>();
    expectTypeOf<'rejected'>().toExtend<WriteErrorCode>();
  });
  it('NFR-18 NFR-11 RequestInstrumentation is exported and optional in no existing type', () => {
    expectTypeOf<RequestInstrumentation['start']>().parameters.toEqualTypeOf<[RequestAttempt]>();
    expectTypeOf<RequestAttempt>().toEqualTypeOf<{ readonly connection: string; readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly host: string }>();
  });
  it('NFR-18 CONN-1 the MCP additions are optional on existing types', () => {
    expectTypeOf<ConnectionSettings['kind']>().toEqualTypeOf<'openapi' | 'mcp' | undefined>();
    expectTypeOf<undefined>().toExtend<UpstreamResolver['resolveTools']>();
    expectTypeOf<UpstreamResolver['resolveTools']>().toEqualTypeOf<
      ((input: { connection: ConnectionSettings }) => Promise<ToolListOutcome>) | undefined
    >();
    expectTypeOf<'upstream_error'>().toExtend<ReadErrorCode>();
  });
  it('NFR-18 EXE-4 WriteAdapter.callOnce takes an HTTP or MCP target and answers codes only', () => {
    expectTypeOf<CallTarget>().toEqualTypeOf<
      { readonly kind: 'http'; readonly mapping: UpstreamMapping } | { readonly kind: 'mcp'; readonly tool: string }
    >();
    expectTypeOf<Parameters<WriteAdapter['callOnce']>[0]['target']>().toEqualTypeOf<CallTarget>();
    expectTypeOf<Parameters<WriteAdapter['callOnce']>[0]['beforeSend']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<CallOutcome['result']>().toEqualTypeOf<'accepted' | 'refused' | 'unknown' | 'not_sent'>();
    expectTypeOf<CallOutcome['code']>().toEqualTypeOf<WriteErrorCode | undefined>();
  });
});

describe('NFR-18 connector SDK 0.6.0 code operations are additive', () => {
  it('NFR-18 OPS-5 the code types are exported and CodeWriteOperation.write takes records and arguments', () => {
    expectTypeOf<Parameters<CodeWriteOperation['write']>>().toEqualTypeOf<[CodeWriteContext, readonly WriteRecord[], CodeArgs]>();
    expectTypeOf<ReturnType<CodeWriteOperation['write']>>().toEqualTypeOf<Promise<readonly RecordOutcome[]>>();
    expectTypeOf<Parameters<CodeReadOperation['read']>>().toEqualTypeOf<[CodeContext, CodeArgs]>();
    expectTypeOf<ReturnType<CodeReadOperation['read']>>().toEqualTypeOf<Promise<CodeReadResult>>();
    expectTypeOf<ReturnType<CodeCallOperation['call']>>().toEqualTypeOf<Promise<CodeCallOutcome>>();
    expectTypeOf<CodeCallOutcome>().toEqualTypeOf<{ readonly ok: true } | { readonly ok: false; readonly definite: boolean }>();
    expectTypeOf<RecordOutcome>().toEqualTypeOf<'ok' | 'failed' | 'retriable'>();
    expectTypeOf<CodeOperation['kind']>().toEqualTypeOf<'read' | 'write' | 'call'>();
    expectTypeOf<PresetModule['operations']>().toEqualTypeOf<Readonly<Record<string, CodeOperation>>>();
    expectTypeOf<CodeContext['http']>().toEqualTypeOf<CodeHttpClient>();
    expectTypeOf<Parameters<CodeHttpClient['send']>>().toEqualTypeOf<[CodeHttpRequest]>();
    expectTypeOf<Extract<CodeHttpResponse, { ok: false }>['code']>().toEqualTypeOf<ReadErrorCode>();
    expectTypeOf(parsePresetModule).returns.toEqualTypeOf<{ ok: true; module: PresetModule } | { ok: false; message: string }>();
    // The existing opaque CallOutcome keeps its name and shape (F1).
    expectTypeOf<CallOutcome['result']>().toEqualTypeOf<'accepted' | 'refused' | 'unknown' | 'not_sent'>();
  });
  it('NFR-18 OPS-6 TemplateValue gains the record form and BulkMapping.status takes index or key', () => {
    expectTypeOf<{ readonly record: string; readonly default?: string | number | boolean; readonly join?: string }>().toExtend<TemplateValue>();
    expectTypeOf<{ readonly arg: string }>().toExtend<TemplateValue>();
    expectTypeOf<BulkMapping['status']['index']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<BulkMapping['status']['key']>().toEqualTypeOf<string | undefined>();
  });
  it('NFR-18 RecordWriteAdapter and CodeAdapter are separate interfaces; WriteAdapter keeps its two methods', () => {
    expectTypeOf<keyof WriteAdapter>().toEqualTypeOf<'submitBulk' | 'bulkStatus' | 'callOnce'>();
    expectTypeOf<keyof RecordWriteAdapter>().toEqualTypeOf<'writeRecord'>();
    expectTypeOf<keyof CodeAdapter>().toEqualTypeOf<'codeRead' | 'codeWrite' | 'codeCall'>();
    expectTypeOf<Parameters<WriteAdapter['bulkStatus']>[0]['keys']>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<ReturnType<RecordWriteAdapter['writeRecord']>>().toEqualTypeOf<Promise<RecordSendOutcome>>();
    expectTypeOf<ReturnType<CodeAdapter['codeWrite']>>().toEqualTypeOf<Promise<CodeWriteOutcome>>();
    expectTypeOf<ReturnType<CodeAdapter['codeCall']>>().toEqualTypeOf<Promise<CodeCallResult>>();
    expectTypeOf<Parameters<CodeAdapter['codeWrite']>[0]['records']>().toEqualTypeOf<readonly WriteRecord[]>();
  });
});
