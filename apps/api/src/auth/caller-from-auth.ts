// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuthInfo } from '@modelcontextprotocol/server';
import { serviceSubject, type Caller } from '@aiops/core';

const MAX_GROUPS = 256;
const MAX_GROUP_LENGTH = 255;
/** Largest seconds value a JavaScript Date can hold (8.64e15 ms). */
const MAX_AUTH_TIME_SECONDS = 8.64e12;

/**
 * The caller of a verified request. A service token (`extra.service`, AUTH-4) gives
 * `service:<client_id>` with no groups and no authTime. Otherwise: `sub`, the OAuth client (`azp`) and the flat
 * `groups` claim (AUTH-3, ADR 0004), plus `auth_time` for step-up checks (AUTH-6). Claims are untrusted in shape even when the
 * signature is valid, so they are parsed here. The token is never copied (AUTH-7).
 */
export function callerFromAuthInfo(info: AuthInfo): Caller {
  const extra = info.extra ?? {};
  const sub = extra.sub;
  if (typeof sub !== 'string' || sub === '') throw new Error('verified token without a subject');
  // A configured service account (AUTH-4): its own subject namespace, no groups, and never an
  // authTime, so a step-up check fails closed for it (AUTH-6).
  const service = extra.service;
  if (typeof service === 'string' && service !== '') {
    return { subject: serviceSubject(service), ...(info.clientId === '' ? {} : { clientId: info.clientId }), groups: [] };
  }
  const raw = extra.groups;
  const groups = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= MAX_GROUP_LENGTH).slice(0, MAX_GROUPS)
    : [];
  // OIDC `auth_time` is seconds since the epoch; anything else, or a value outside what a Date can
  // hold, is ignored rather than guessed (the step-up check then fails closed).
  const authTime = extra.auth_time;
  return {
    subject: sub,
    ...(info.clientId === '' ? {} : { clientId: info.clientId }),
    groups,
    ...(typeof authTime === 'number' && Number.isFinite(authTime) && authTime > 0 && authTime <= MAX_AUTH_TIME_SECONDS ? { authTime: new Date(authTime * 1000) } : {}),
  };
}
