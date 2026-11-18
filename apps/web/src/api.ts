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
  const post = async (url: string, csrfToken: string, body?: unknown): Promise<DecideOutcome> => {
    const response = await fetcher(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new Unauthenticated();
    const answer = (await response.json().catch(() => ({}))) as { status?: unknown; start?: unknown; error?: unknown };
    if (response.ok) return { ok: true, status: String(answer.status), ...(typeof answer.start === 'string' ? { start: answer.start } : {}) };
    return { ok: false, error: typeof answer.error === 'string' ? answer.error : `HTTP ${String(response.status)}` };
  };
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
