// @mandate/connector-sdk 1.3.0 public API report — generated, do not edit

// file: code.d.ts
import type { HttpMethod } from './mapping.js';
import type { ReadErrorCode } from './read.js';
import type { RecordSendOutcome } from './write.js';
export type CodeQueryValue = string | number | boolean | readonly (string | number | boolean)[];
export interface CodeHttpRequest {
    readonly method: HttpMethod;
    readonly path: string;
    readonly query?: Readonly<Record<string, CodeQueryValue>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
}
export type CodeHttpResponse = {
    readonly ok: true;
    readonly status: number;
    readonly json: unknown;
} | {
    readonly ok: false;
    readonly code: ReadErrorCode;
    readonly status?: number;
};
export interface CodeHttpClient {
    send(request: CodeHttpRequest): Promise<CodeHttpResponse>;
}
export interface CodeContext {
    readonly http: CodeHttpClient;
    readonly signal: AbortSignal;
    readonly connection: {
        readonly id: string;
    };
    readonly params?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}
export type CodeArgs = Readonly<Record<string, unknown>>;
export type WriteRecord = Readonly<Record<string, unknown>>;
export interface CodeReadResult {
    readonly items: readonly WriteRecord[];
    readonly total?: number;
}
export type RecordOutcome = 'ok' | 'failed' | 'retriable';
export declare function recordOutcomeOf(outcome: RecordSendOutcome): RecordOutcome;
export type CodeCallOutcome = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly definite: boolean;
};
export interface CodeReadOperation {
    readonly kind: 'read';
    read(ctx: CodeContext, args: CodeArgs): Promise<CodeReadResult>;
}
export type CodeWriteDirection = 'forward' | 'rollback';
export interface CodeWriteContext extends CodeContext {
    readonly direction: CodeWriteDirection;
}
export interface CodeWriteOperation {
    readonly kind: 'write';
    write(ctx: CodeWriteContext, records: readonly WriteRecord[], args: CodeArgs): Promise<readonly RecordOutcome[]>;
}
export interface CodeCallOperation {
    readonly kind: 'call';
    call(ctx: CodeContext, args: CodeArgs): Promise<CodeCallOutcome>;
}
export type CodeOperation = CodeReadOperation | CodeWriteOperation | CodeCallOperation;
export interface PresetModule {
    readonly operations: Readonly<Record<string, CodeOperation>>;
}
export declare function parsePresetModule(value: unknown): {
    ok: true;
    module: PresetModule;
} | {
    ok: false;
    message: string;
};

// file: connection.d.ts
export type AuthSettings = {
    scheme: 'bearer';
} | {
    scheme: 'api_key';
    header: string;
} | {
    scheme: 'basic';
} | {
    scheme: 'oauth_client_credentials';
    tokenUrl: string;
    scopes: readonly string[];
} | {
    scheme: 'oauth_password';
    tokenUrl: string;
    scopes: readonly string[];
    clientAuth: 'basic' | 'body';
} | {
    scheme: 'oauth1';
    signatureMethod: 'HMAC-SHA256' | 'HMAC-SHA1';
};
export interface ConnectionSettings {
    id: string;
    kind?: 'openapi' | 'mcp';
    baseUrl: string;
    auth?: AuthSettings;
    credentialRef?: string;
    timeoutMs: number;
    retry: {
        maxAttempts: number;
        initialBackoffMs: number;
    };
    maxConcurrency: number;
    minIntervalMs?: number;
    allowPrivateNetwork: boolean;
    extraHosts: readonly string[];
    presetParams?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

// file: credentials.d.ts
export declare const CREDENTIAL_SCHEMES: readonly ["bearer", "api_key", "basic", "oauth_client_credentials", "webhook_url", "oauth_password", "oauth1"];
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];
export type SecretMaterial = {
    readonly token: string;
} | {
    readonly key: string;
} | {
    readonly username: string;
    readonly password: string;
} | {
    readonly client_id: string;
    readonly client_secret: string;
} | {
    readonly url: string;
} | {
    readonly client_id: string;
    readonly client_secret: string;
    readonly username: string;
    readonly password: string;
} | {
    readonly consumer_key: string;
    readonly consumer_secret: string;
    readonly token: string;
    readonly token_secret: string;
};
export declare function secretFieldNames(scheme: CredentialScheme): readonly string[];
export declare function parseSecret(scheme: CredentialScheme, value: unknown): {
    ok: true;
    secret: Readonly<Record<string, string>>;
} | {
    ok: false;
    message: string;
};
export interface CredentialSource {
    readonly ref: string;
    readonly scheme: CredentialScheme;
    open(): Promise<Readonly<Record<string, string>>>;
}

// file: index.d.ts
export * from './version.js';
export * from './credentials.js';
export * from './mapping.js';
export * from './connection.js';
export * from './resolver.js';
export * from './read.js';
export * from './write.js';
export * from './mcp.js';
export * from './instrumentation.js';
export * from './code.js';

// file: instrumentation.d.ts
import type { HttpMethod } from './mapping.js';
export interface RequestAttempt {
    readonly connection: string;
    readonly method: HttpMethod;
    readonly host: string;
}
export interface RequestAttemptEnd {
    readonly status?: number;
    readonly errorCode?: string;
}
export interface RequestSpan {
    readonly headers: Readonly<Record<string, string>>;
    end(result: RequestAttemptEnd): void;
}
export interface RequestInstrumentation {
    start(attempt: RequestAttempt): RequestSpan;
}

// file: mapping.d.ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type TemplateValue = string | number | boolean | {
    readonly arg: string;
    readonly default?: string | number | boolean;
    readonly join?: string;
}
 | {
    readonly record: string;
    readonly default?: string | number | boolean;
    readonly join?: string;
};
export interface ResponseMapping {
    items?: string;
    total?: string;
    flatten?: {
        path: string;
        key: string;
        value: string;
    };
    fieldsFromArg?: string;
    maxItems: number;
}
export type StateValue = string | number | boolean;
export interface BulkMapping {
    body: {
        wrap?: string;
        nest?: {
            path: string;
            key: string;
            value: string;
            keep: readonly string[];
        };
    };
    batchId: string;
    status: {
        method: 'GET';
        path: string;
        items: string;
        index?: string;
        key?: string;
        state: string;
        states: {
            ok: readonly StateValue[];
            failed: readonly StateValue[];
            retriable: readonly StateValue[];
            open: readonly StateValue[];
        };
    };
}
export interface UpstreamMapping {
    operation?: string;
    method?: HttpMethod;
    path?: string;
    pathParams: Record<string, TemplateValue>;
    query: Record<string, TemplateValue>;
    headers: Record<string, TemplateValue>;
    body?: TemplateValue;
    response: ResponseMapping;
    bulk?: BulkMapping;
    idempotency?: {
        header: string;
    };
}

// file: mcp.d.ts
import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { ReadErrorCode, ReadOutcome } from './read.js';
export interface McpToolDefinition {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations?: Readonly<Record<string, unknown>>;
}
export interface McpListedTool {
    readonly definition: McpToolDefinition;
    readonly hash: string;
}
export type ToolListOutcome = {
    ok: true;
    tools: readonly McpListedTool[];
    dropped: number;
    durationMs: number;
} | {
    ok: false;
    code: ReadErrorCode;
    status?: number;
    durationMs: number;
    message: string;
};
export interface McpToolAdapter {
    listTools(input: {
        connection: ConnectionSettings;
        credential?: CredentialSource;
    }): Promise<ToolListOutcome>;
    callTool(input: {
        connection: ConnectionSettings;
        tool: string;
        args: Readonly<Record<string, unknown>>;
        credential?: CredentialSource;
        retryable: boolean;
    }): Promise<ReadOutcome>;
}
export declare function canonicalJson(value: unknown): string;
export declare function mcpToolHash(tool: McpToolDefinition): string;

// file: read.d.ts
import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { UpstreamMapping } from './mapping.js';
export type ReadErrorCode = 'timeout' | 'egress_denied' | 'http_status' | 'invalid_response' | 'credential_missing' | 'credential_unusable' | 'network' | 'busy' | 'mapping'
 | 'upstream_error';
export type ReadOutcome = {
    ok: true;
    status: number;
    durationMs: number;
    items?: readonly Record<string, unknown>[];
    total?: number;
    value?: unknown;
    truncated: boolean;
} | {
    ok: false;
    code: ReadErrorCode;
    status?: number;
    durationMs: number;
    message: string;
};
export interface ScopeReport {
    detectable: boolean;
    source: 'oauth_token_response' | 'jwt_claims' | 'none';
    values: readonly string[];
}
export interface ConnectionTestReport {
    ok: boolean;
    operation: string;
    status?: number;
    durationMs: number;
    itemCount?: number;
    code?: ReadErrorCode;
    message?: string;
    scopes: ScopeReport;
}
export interface ReadAdapter {
    read(input: {
        connection: ConnectionSettings;
        mapping: UpstreamMapping;
        args: Readonly<Record<string, unknown>>;
        credential?: CredentialSource;
        exactValues?: boolean;
    }): Promise<ReadOutcome>;
    detectScopes(input: {
        connection: ConnectionSettings;
        credential?: CredentialSource;
    }): Promise<ScopeReport>;
}

// file: resolver.d.ts
import type { ConnectionSettings } from './connection.js';
import type { HttpMethod, UpstreamMapping } from './mapping.js';
import type { ToolListOutcome } from './mcp.js';
export interface CatalogEntry {
    key: string;
    operationId?: string;
    method: HttpMethod;
    path: string;
    summary?: string;
    inputSchema: Record<string, unknown>;
    defaultMapping: UpstreamMapping;
}
export interface SpecIssue {
    path: readonly (string | number)[];
    message: string;
}
export interface UpstreamResolver {
    resolveSpec(input: {
        connection: ConnectionSettings;
        spec: {
            file: string;
        } | {
            url: string;
        };
        include?: readonly string[];
    }): Promise<{
        ok: true;
        catalog: readonly CatalogEntry[];
    } | {
        ok: false;
        issues: readonly SpecIssue[];
    }>;
    resolveTools?(input: {
        connection: ConnectionSettings;
    }): Promise<ToolListOutcome>;
}

// file: version.d.ts
export declare const CONNECTOR_SDK_VERSION = "1.3.0";

// file: write.d.ts
import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { CodeArgs, CodeCallOperation, CodeReadOperation, CodeWriteDirection, CodeWriteOperation, RecordOutcome, WriteRecord } from './code.js';
import type { ResponseMapping, UpstreamMapping } from './mapping.js';
import type { ReadErrorCode, ReadOutcome } from './read.js';
export type WriteErrorCode = ReadErrorCode | 'rejected';
export type BulkItemState = 'ok' | 'failed' | 'retriable' | 'open';
export interface WriteFailure {
    ok: false;
    code: WriteErrorCode;
    status?: number;
    durationMs: number;
    retriable: boolean;
}
export type BulkSubmitOutcome = {
    ok: true;
    batchId: string;
    status: number;
    durationMs: number;
} | WriteFailure;
export type BulkStatusOutcome = {
    ok: true;
    items: readonly {
        index: number;
        state: BulkItemState;
    }[];
    durationMs: number;
} | WriteFailure;
export type CallTarget = {
    readonly kind: 'http';
    readonly mapping: UpstreamMapping;
} | {
    readonly kind: 'mcp';
    readonly tool: string;
};
export interface CallOutcome {
    readonly result: 'accepted' | 'refused' | 'unknown' | 'not_sent';
    readonly code?: WriteErrorCode;
    readonly status?: number;
    readonly durationMs: number;
}
export interface WriteAdapter {
    submitBulk(input: {
        connection: ConnectionSettings;
        mapping: UpstreamMapping;
        records: readonly Readonly<Record<string, unknown>>[];
        credential?: CredentialSource;
    }): Promise<BulkSubmitOutcome>;
    bulkStatus(input: {
        connection: ConnectionSettings;
        mapping: UpstreamMapping;
        batchId: string;
        credential?: CredentialSource;
        keys?: readonly string[];
    }): Promise<BulkStatusOutcome>;
    callOnce?(input: {
        connection: ConnectionSettings;
        target: CallTarget;
        args: Readonly<Record<string, unknown>>;
        credential?: CredentialSource;
        idempotencyKey?: string;
        beforeSend: () => Promise<void>;
    }): Promise<CallOutcome>;
}
export type RecordSendOutcome = {
    ok: true;
    status: number;
    durationMs: number;
} | WriteFailure;
export interface RecordWriteAdapter {
    writeRecord(input: {
        connection: ConnectionSettings;
        mapping: UpstreamMapping;
        record: WriteRecord;
        args: CodeArgs;
        credential?: CredentialSource;
    }): Promise<RecordSendOutcome>;
}
export type CodeWriteOutcome = {
    ok: true;
    outcomes: readonly RecordOutcome[];
    durationMs: number;
} | WriteFailure;
export type CodeCallResult = {
    ok: true;
    durationMs: number;
} | {
    ok: false;
    definite: boolean;
    code: WriteErrorCode;
    durationMs: number;
};
export interface CodeAdapter {
    codeRead(input: {
        connection: ConnectionSettings;
        name: string;
        operation: CodeReadOperation;
        args: CodeArgs;
        response: ResponseMapping;
        credential?: CredentialSource;
        exactValues?: boolean;
    }): Promise<ReadOutcome>;
    codeWrite(input: {
        connection: ConnectionSettings;
        name: string;
        operation: CodeWriteOperation;
        records: readonly WriteRecord[];
        args: CodeArgs;
        direction?: CodeWriteDirection;
        credential?: CredentialSource;
        onProgress?: () => void;
    }): Promise<CodeWriteOutcome>;
    codeCall(input: {
        connection: ConnectionSettings;
        name: string;
        operation: CodeCallOperation;
        args: CodeArgs;
        credential?: CredentialSource;
    }): Promise<CodeCallResult>;
}
