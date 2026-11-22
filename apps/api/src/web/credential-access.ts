// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { LoadedConfiguration } from '@mandate/config';
import { rolesOf, type AuditAction, type AuditLog, type Caller } from '@mandate/core';
import { deny, pageDenial, pageOf, type PageChecks, type PageContext, type PageDenial, type PageRequest, type RequiredChecks } from './access.js';
import { pageCorrelation } from './correlation.js';

/** What a page user may manage: the configured refs their roles list, or all of them for `*` (UI-5, UI-7). */
export interface CredentialAccess {
  readonly all: boolean;
  readonly refs: ReadonlySet<string>;
}

export function credentialAccess(configuration: LoadedConfiguration, caller: Pick<Caller, 'subject' | 'groups'>): CredentialAccess {
  const roles = rolesOf(caller, configuration.policy);
  const listed = roles.flatMap((role) => configuration.credentialManagers.get(role) ?? []);
  const all = listed.includes('*');
  const refs = new Set([...configuration.credentialRefs.keys()].filter((ref) => all || listed.includes(ref)));
  return { all, refs };
}

/** A connection may be tested by who manages its credential; one without a credential only by `*`. */
export function mayTestConnection(configuration: LoadedConfiguration, access: CredentialAccess, connectionId: string): boolean {
  const connection = configuration.connectionSettings.get(connectionId);
  if (connection === undefined) return false;
  return connection.credentialRef === undefined ? access.all : access.refs.has(connection.credentialRef);
}

const ID_SHAPE = /^[a-z][a-z0-9_-]{0,62}$/;

/** A path parameter as the audit records it: configuration-ID shaped, or a fixed placeholder, so nothing arbitrary is stored. */
export const auditedId = (value: string): string => (ID_SHAPE.test(value) ? value : '(invalid)');

/** One credential page request: its session, configuration snapshot (taken once) and correlation ID. */
export interface CredentialRequest {
  readonly page: PageContext;
  readonly configuration: LoadedConfiguration;
  readonly access: CredentialAccess;
  readonly correlationId: string;
}

export function credentialRequest(req: PageRequest, res: Response, configuration: LoadedConfiguration): CredentialRequest {
  const page = pageOf(req);
  return { page, configuration, access: credentialAccess(configuration, page.session), correlationId: pageCorrelation(req, res) };
}

/**
 * Runs the route's checks in the fixed order (permission → Origin + CSRF → fresh, SEC-8)
 * and, on a refusal, writes the denied audit row before answering 403 (AUD-1).
 */
export async function enforce(
  audit: AuditLog,
  req: PageRequest,
  request: CredentialRequest,
  required: RequiredChecks,
  checks: PageChecks,
  denied: { readonly action: AuditAction; readonly subject: string; readonly details: Readonly<Record<string, unknown>> },
): Promise<void> {
  const reason = pageDenial(req.headers, request.page.session, required, checks);
  if (reason === undefined) return;
  await auditDenied(audit, request, denied, reason);
  throw deny(403, reason);
}

export async function auditDenied(
  audit: AuditLog,
  request: CredentialRequest,
  denied: { readonly action: AuditAction; readonly subject: string; readonly details: Readonly<Record<string, unknown>> },
  reason: PageDenial | 'invalid_secret',
): Promise<void> {
  const { session } = request.page;
  await audit.append({
    id: randomUUID(),
    actor: session.subject,
    clientId: session.clientId,
    action: denied.action,
    subject: denied.subject,
    outcome: 'denied',
    correlationId: request.correlationId,
    details: { ...denied.details, reason },
  });
}
