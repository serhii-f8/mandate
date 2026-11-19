export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TemplateValue =
  | string
  | number
  | boolean
  | { readonly arg: string; readonly default?: string | number | boolean; readonly join?: string };

export interface ResponseMapping {
  items?: string;
  total?: string;
  flatten?: { path: string; key: string; value: string };
  fieldsFromArg?: string;
  maxItems: number;
}

export type StateValue = string | number | boolean;

export interface BulkMapping {
  body: { wrap?: string; nest?: { path: string; key: string; value: string; keep: readonly string[] } };
  /** Dotted path of the batch ID in the submit response. */
  batchId: string;
  status: {
    method: 'GET';
    /** Contains `{batch_id}`. */
    path: string;
    items: string;
    index: string;
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
  /** since 0.3.0, additive */
  bulk?: BulkMapping;
  /**
   * since 0.6.0, additive. Header that carries the idempotency key of an opaque write
   * (`<changeset-id>:call`), so a call whose outcome is unknown can be resent (EXE-4).
   */
  idempotency?: { header: string };
}
