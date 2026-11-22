// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { z } from 'zod';

export const CREDENTIAL_SCHEMES = ['bearer', 'api_key', 'basic', 'oauth_client_credentials', 'webhook_url', 'oauth_password', 'oauth1'] as const;
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];

/** Secret material per scheme (SEC-2). */
export type SecretMaterial =
  | { readonly token: string }
  | { readonly key: string }
  | { readonly username: string; readonly password: string }
  | { readonly client_id: string; readonly client_secret: string }
  | { readonly url: string }
  | { readonly client_id: string; readonly client_secret: string; readonly username: string; readonly password: string }
  | { readonly consumer_key: string; readonly consumer_secret: string; readonly token: string; readonly token_secret: string };

const FIELDS: Record<CredentialScheme, readonly string[]> = {
  bearer: ['token'],
  api_key: ['key'],
  basic: ['username', 'password'],
  oauth_client_credentials: ['client_id', 'client_secret'],
  webhook_url: ['url'],
  oauth_password: ['client_id', 'client_secret', 'username', 'password'],
  oauth1: ['consumer_key', 'consumer_secret', 'token', 'token_secret'],
};

const secretString = z.string().min(1).max(8192);

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

/** A webhook URL is itself the secret (NTF-1): an http(s) URL of at most 2048 characters. */
const webhookUrlSchema = z.strictObject({ url: secretString.max(2048).refine(isHttpUrl) });

function schemaFor(scheme: CredentialScheme): z.ZodType<Record<string, string>> {
  if (scheme === 'webhook_url') return webhookUrlSchema;
  const shape: Record<string, z.ZodString> = {};
  for (const f of FIELDS[scheme]) shape[f] = secretString;
  return z.strictObject(shape);
}

/** Field names of the secret for a scheme (drives the credential form). */
export function secretFieldNames(scheme: CredentialScheme): readonly string[] {
  return FIELDS[scheme];
}

/** Parse secret material. The message names fields only; it never quotes input (SEC-3). */
export function parseSecret(
  scheme: CredentialScheme,
  value: unknown,
): { ok: true; secret: Readonly<Record<string, string>> } | { ok: false; message: string } {
  const r = schemaFor(scheme).safeParse(value);
  if (r.success) return { ok: true, secret: r.data };
  const fields = [...new Set(r.error.issues.map((i) => (i.path.length > 0 ? i.path.join('.') : '(value)')))];
  return {
    ok: false,
    message: `invalid secret for scheme ${scheme}: check ${fields.join(', ')}`,
  };
}

/** Opens secret material on demand; implementations decrypt at the point of use (SEC-2). */
export interface CredentialSource {
  readonly ref: string;
  readonly scheme: CredentialScheme;
  open(): Promise<Readonly<Record<string, string>>>;
}
