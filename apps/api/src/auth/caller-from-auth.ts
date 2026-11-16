import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Caller } from '@aiops/core';

const MAX_GROUPS = 256;
const MAX_GROUP_LENGTH = 255;

/**
 * The caller of a verified request: `sub`, the OAuth client (`azp`) and the flat
 * `groups` claim (AUTH-3, ADR 0004). Claims are untrusted in shape even when the
 * signature is valid, so they are parsed here. The token is never copied (AUTH-7).
 */
export function callerFromAuthInfo(info: AuthInfo): Caller {
  const extra = info.extra ?? {};
  const sub = extra.sub;
  if (typeof sub !== 'string' || sub === '') throw new Error('verified token without a subject');
  const raw = extra.groups;
  const groups = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= MAX_GROUP_LENGTH).slice(0, MAX_GROUPS)
    : [];
  return { subject: sub, ...(info.clientId === '' ? {} : { clientId: info.clientId }), groups };
}
