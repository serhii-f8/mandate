// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
export type AuthSettings =
  | { scheme: 'bearer' }
  | { scheme: 'api_key'; header: string }
  | { scheme: 'basic' }
  | { scheme: 'oauth_client_credentials'; tokenUrl: string; scopes: readonly string[] }
  | { scheme: 'oauth_password'; tokenUrl: string; scopes: readonly string[]; clientAuth: 'basic' | 'body' }
  | { scheme: 'oauth1'; signatureMethod: 'HMAC-SHA256' | 'HMAC-SHA1' };

export interface ConnectionSettings {
  id: string;
  /** Upstream protocol; absent means `openapi` (since 0.6.0, additive). */
  kind?: 'openapi' | 'mcp';
  baseUrl: string;
  auth?: AuthSettings;
  credentialRef?: string;
  timeoutMs: number;
  retry: { maxAttempts: number; initialBackoffMs: number };
  maxConcurrency: number;
  /** Minimum time between two requests of the connection, in milliseconds; absent means unpaced (since 1.1.0, additive). */
  minIntervalMs?: number;
  allowPrivateNetwork: boolean;
  /** Extra hosts allowed for egress: the spec URL host. The token URL host is derived from `auth`. */
  extraHosts: readonly string[];
  /**
   * The parameter values of the preset the connection binds, defaults filled in; code operations
   * receive them as `ctx.params` (CONN-8; since 1.1.0, additive). Absent without a preset.
   */
  presetParams?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}
