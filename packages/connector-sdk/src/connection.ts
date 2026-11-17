export type AuthSettings =
  | { scheme: 'bearer' }
  | { scheme: 'api_key'; header: string }
  | { scheme: 'basic' }
  | { scheme: 'oauth_client_credentials'; tokenUrl: string; scopes: readonly string[] };

export interface ConnectionSettings {
  id: string;
  baseUrl: string;
  auth?: AuthSettings;
  credentialRef?: string;
  timeoutMs: number;
  retry: { maxAttempts: number; initialBackoffMs: number };
  maxConcurrency: number;
  allowPrivateNetwork: boolean;
  /** Extra hosts allowed for egress: the spec URL host. The token URL host is derived from `auth`. */
  extraHosts: readonly string[];
}
