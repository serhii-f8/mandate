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

const LOGIN = '/auth/login?return_to=/app/credentials';

export const loginUrl = (fresh: boolean): string => (fresh ? `${LOGIN}&fresh=1` : LOGIN);

async function json(response: Response): Promise<unknown> {
  if (response.status === 401) throw new Unauthenticated();
  return response.json();
}

/** The api's trusted-page REST calls; the CSRF token goes in a header on every mutation (SEC-8). */
export function createApi(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  return {
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
