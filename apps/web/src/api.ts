// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuditEventModel, AuditFilters } from '@aiops/widgets';
import type { ConnectionTestReport, CredentialRow, SaveResult } from './views/CredentialsView.js';

export interface Session {
  subject: string;
  username?: string;
  roles: string[];
  csrfToken: string;
  /** ISO 8601 time of the login at the identity provider. */
  authTime: string;
  /** Recent enough to change credentials (SEC-8). */
  fresh: boolean;
  /** ISO 8601 time the page session ends. */
  expiresAt: string;
  /** The role may open the audit page; the api enforces it again on every request (SEC-1). */
  viewAudit: boolean;
}

export interface CredentialListEntry extends CredentialRow {
  fields: string[];
}

/** Thrown when the api answers 401: the page must start a login. */
export class Unauthenticated extends Error {
  constructor() {
    super('unauthenticated');
  }
}

/** Thrown when the api answers 404: the page shows "not found" (also for a change-set the user may not see). */
export class NotFound extends Error {
  constructor() {
    super('not found');
  }
}

/** Thrown when the api answers 400 to an audit query: the filter values are malformed. */
export class BadQuery extends Error {
  constructor() {
    super('bad query');
  }
}

export interface AuditPage {
  events: AuditEventModel[];
  nextCursor?: string;
}

/** Query string of the non-empty filters (and the cursor), through URLSearchParams. */
function auditQuery(filters: AuditFilters & { cursor?: string }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (typeof value === 'string' && value !== '') params.set(key, value);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** Login URL that returns to `returnTo`; `fresh` asks for a new authentication (SEC-8, AUTH-6). */
export const loginUrl = (returnTo: string, fresh: boolean): string =>
  `/auth/login?return_to=${encodeURIComponent(returnTo)}${fresh ? '&fresh=1' : ''}`;

/** Leaves the page for a login; the promise never settles so no result is shown meanwhile. */
export function toLogin(returnTo: string, fresh: boolean): Promise<never> {
  window.location.assign(loginUrl(returnTo, fresh));
  return new Promise<never>(() => undefined);
}

export interface QueueEntry {
  id: string;
  operation: string;
  title: string;
  requester: string;
  total: number;
  step: number;
  steps: number;
  submittedAt?: string;
  expiresAt: string;
}
export interface ApprovalQueue {
  items: QueueEntry[];
  next?: string;
}

export interface ViewerBlock {
  canDecide: boolean;
  reason: string | null;
  fresh: boolean;
  stepUpSatisfied: boolean;
  canStart: boolean;
  /** The requester of an unexpired prepared change-set may submit it and derive exclusions (UI-3). */
  canSubmit: boolean;
  canExclude: boolean;
}
export interface StepDecision {
  approver: string;
  name?: string;
  decision: string;
  channel: string;
  comment?: string;
  ts: string;
}
export interface ChangeSetDetail {
  id: string;
  status: string;
  hash?: string;
  /** The change-set this one was derived from by an exclusion (CS-5). */
  derivedFrom?: string;
  /** Absent means `diff`. */
  kind?: 'opaque' | 'diff';
  operation: { id: string; title?: string; description?: string; risk?: string };
  connection: string;
  request: { args: Record<string, unknown>; requester: string; clientId?: string; createdAt: string; submittedAt?: string };
  policy?: { rule: string; role: string; approval?: { reason: string; threshold?: number; included: number } };
  stats: { total: number; included: number; excluded: Record<string, number>; written: number; failed: number; skipped: number };
  expiresAt: string;
  progress?: { total: number; done: number; failed: number; skipped: number };
  errorCode?: string;
  approval?: {
    round: number;
    steps: { step: number; role: string; decision?: StepDecision }[];
    awaitingRole?: string;
    stepUp?: { maxAgeSeconds: number };
  };
  /** Present once execution is summarised (UI-4). */
  drift?: number;
  rollback: { available: boolean; count?: number; until?: string; reason?: string; stats?: { restored: number; skipped: number; failed: number } };
  viewer: ViewerBlock;
}
export interface ItemRow {
  targetId: string;
  status: string;
  reason?: string;
  before: unknown;
  after: unknown;
  error?: string;
}
export interface ItemsPage {
  items: ItemRow[];
  next?: string;
}
export interface Sample {
  seed: string;
  items: ItemRow[];
}
export interface DecideBody {
  decision: 'approve' | 'reject' | 'return';
  hash: string;
  count: number;
  comment?: string;
}
export type DecideOutcome = { ok: true; status: string; start?: string } | { ok: false; error: string };
export type SubmitOutcome = { ok: true; status: string; approvalUrl?: string } | { ok: false; error: string };
export type ExcludeOutcome = { ok: true; id: string; hash: string } | { ok: false; error: string; count?: number };

/** The refusal code of a failed POST, or its HTTP status. */
const errorOf = (answer: { error?: unknown }, response: Response): string =>
  typeof answer.error === 'string' ? answer.error : `HTTP ${String(response.status)}`;

async function json(response: Response): Promise<unknown> {
  if (response.status === 401) throw new Unauthenticated();
  if (response.status === 404) throw new NotFound();
  return response.json();
}

/** The api's trusted-page REST calls; the CSRF token goes in a header on every mutation (SEC-8). */
export function createApi(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  const get = async <T>(label: string, url: string): Promise<T> => {
    const response = await fetcher(url, { credentials: 'same-origin' });
    if (!response.ok && response.status !== 401 && response.status !== 404) throw new Error(`${label}: HTTP ${String(response.status)}`);
    return (await json(response)) as T;
  };
  // A mutation: the CSRF token always, a JSON body when given (SEC-8); 401 throws, any answer body is read leniently.
  const send = async (url: string, csrfToken: string, body?: unknown): Promise<{ response: Response; answer: Record<string, unknown> }> => {
    const response = await fetcher(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new Unauthenticated();
    const answer: unknown = await response.json().catch(() => ({}));
    return { response, answer: typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {} };
  };
  const post = async (url: string, csrfToken: string, body?: unknown): Promise<DecideOutcome> => {
    const { response, answer } = await send(url, csrfToken, body);
    if (response.ok) return { ok: true, status: String(answer.status), ...(typeof answer.start === 'string' ? { start: answer.start } : {}) };
    return { ok: false, error: errorOf(answer, response) };
  };
  const changesetUrl = (id: string): string => `/api/v1/changesets/${encodeURIComponent(id)}`;
  return {
    approvals: (after?: string): Promise<ApprovalQueue> =>
      get('approvals', `/api/v1/approvals${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`),
    changeset: (id: string): Promise<ChangeSetDetail> => get('changeset', `/api/v1/changesets/${encodeURIComponent(id)}`),
    items(id: string, q: { after?: string; status?: string }): Promise<ItemsPage> {
      const params = new URLSearchParams();
      if (q.after !== undefined) params.set('after', q.after);
      if (q.status !== undefined) params.set('status', q.status);
      const query = params.toString();
      return get('items', `/api/v1/changesets/${encodeURIComponent(id)}/items${query === '' ? '' : `?${query}`}`);
    },
    sample: (id: string, seed?: string): Promise<Sample> =>
      get('sample', `/api/v1/changesets/${encodeURIComponent(id)}/sample${seed === undefined ? '' : `?seed=${encodeURIComponent(seed)}`}`),
    decide: (csrfToken: string, id: string, body: DecideBody): Promise<DecideOutcome> =>
      post(`/api/v1/changesets/${encodeURIComponent(id)}/decision`, csrfToken, body),
    start: (csrfToken: string, id: string): Promise<DecideOutcome> => post(`/api/v1/changesets/${encodeURIComponent(id)}/start`, csrfToken),
    /** Submits a prepared change-set by the hash the requester saw (UI-3). */
    async submit(csrfToken: string, id: string, hash: string): Promise<SubmitOutcome> {
      const { response, answer } = await send(`${changesetUrl(id)}/submit`, csrfToken, { hash });
      if (!response.ok) return { ok: false, error: errorOf(answer, response) };
      const approval = answer.approval;
      const url = typeof approval === 'object' && approval !== null ? (approval as { url?: unknown }).url : undefined;
      return { ok: true, status: String(answer.status), ...(typeof url === 'string' ? { approvalUrl: url } : {}) };
    },
    /** Rolls the finished change-set back by the hash the requester saw (EXE-8); the route needs a fresh login (SEC-8). */
    rollback: (csrfToken: string, id: string, hash: string): Promise<DecideOutcome> => post(`${changesetUrl(id)}/rollback`, csrfToken, { hash }),
    /** Derives a new change-set with the edit; the source stays unchanged (CS-5). Empty lists are left out. */
    async exclude(csrfToken: string, id: string, edit: { hash: string; exclude: string[]; include: string[] }): Promise<ExcludeOutcome> {
      const body = {
        hash: edit.hash,
        ...(edit.exclude.length === 0 ? {} : { exclude: edit.exclude }),
        ...(edit.include.length === 0 ? {} : { include: edit.include }),
      };
      const { response, answer } = await send(`${changesetUrl(id)}/exclusions`, csrfToken, body);
      if (response.ok && typeof answer.id === 'string' && typeof answer.hash === 'string') return { ok: true, id: answer.id, hash: answer.hash };
      if (response.ok) return { ok: false, error: 'invalid_answer' };
      return { ok: false, error: errorOf(answer, response), ...(typeof answer.count === 'number' ? { count: answer.count } : {}) };
    },
    /** The download address of the items (CS-8); the browser navigates to it with the session cookie. */
    exportUrl: (id: string, format: 'csv' | 'xlsx'): string => `${changesetUrl(id)}/export?format=${format}`,
    async audit(query: AuditFilters & { cursor?: string }): Promise<AuditPage> {
      const response = await fetcher(`/api/v1/audit${auditQuery(query)}`, { credentials: 'same-origin' });
      if (response.status === 400) throw new BadQuery();
      if (!response.ok && response.status !== 401) throw new Error(`audit: HTTP ${String(response.status)}`);
      return (await json(response)) as AuditPage;
    },
    /** The download address of the JSON Lines export of the filtered events (AUD-6). */
    auditExportUrl: (filters: AuditFilters): string => `/api/v1/audit/export${auditQuery(filters)}`,
    async session(): Promise<Session> {
      const response = await fetcher('/api/v1/session', { credentials: 'same-origin' });
      if (!response.ok && response.status !== 401) throw new Error(`session: HTTP ${String(response.status)}`);
      return (await json(response)) as Session;
    },
    async credentials(): Promise<CredentialListEntry[]> {
      const response = await fetcher('/api/v1/credentials', { credentials: 'same-origin' });
      if (!response.ok && response.status !== 401) throw new Error(`credentials: HTTP ${String(response.status)}`);
      return (await json(response)) as CredentialListEntry[];
    },
    async save(csrfToken: string, ref: string, secret: Record<string, string>): Promise<SaveResult> {
      const response = await fetcher(`/api/v1/credentials/${encodeURIComponent(ref)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(secret),
      });
      if (response.status === 204) return 'saved';
      const body = (await json(response).catch((error: unknown) => {
        if (error instanceof Unauthenticated) throw error;
        return {};
      })) as { error?: unknown; fields?: unknown };
      if (body.error === 'reauthentication_required') return 'reauthentication_required';
      if (body.error === 'invalid_secret' && Array.isArray(body.fields)) return { error: `The values do not fit the scheme: ${body.fields.map(String).join(', ')}` };
      return { error: typeof body.error === 'string' ? `Not saved: ${body.error}` : `Not saved: HTTP ${String(response.status)}` };
    },
    async test(csrfToken: string, connection: string): Promise<ConnectionTestReport> {
      const response = await fetcher(`/api/v1/connections/${encodeURIComponent(connection)}/test`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken },
      });
      if (!response.ok) {
        await json(response);
        throw new Error(`test: HTTP ${String(response.status)}`);
      }
      return (await response.json()) as ConnectionTestReport;
    },
  };
}
