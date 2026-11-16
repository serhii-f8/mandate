export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TemplateValue =
  | string
  | number
  | boolean
  | { readonly arg: string; readonly default?: string | number | boolean };

export interface ResponseMapping {
  items?: string;
  total?: string;
  flatten?: { path: string; key: string; value: string };
  fieldsFromArg?: string;
  maxItems: number;
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
}
