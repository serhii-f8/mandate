export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TemplateValue =
  | string
  | number
  | boolean
  | { readonly arg: string; readonly default?: string | number | boolean; readonly join?: string }
  /** since 0.6.0, additive. A field of the record being written (per-record writes, OPS-6). */
  | { readonly record: string; readonly default?: string | number | boolean; readonly join?: string };

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
    /**
     * Field of a status entry holding the record's position. Exactly one of `index` and `key`
     * (since 0.6.0: `index` optional because `key` is the alternative).
     */
    index?: string;
    /** since 0.6.0, additive. Field of a status entry holding the record's target ID. */
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
  /** since 0.3.0, additive */
  bulk?: BulkMapping;
  /**
   * since 0.6.0, additive. Header that carries the idempotency key of an opaque write
   * (`<changeset-id>:call`), so a call whose outcome is unknown can be resent (EXE-4).
   */
  idempotency?: { header: string };
}
