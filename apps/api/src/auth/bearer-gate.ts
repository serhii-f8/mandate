import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Caller } from '@aiops/core';
import { callerFromAuthInfo } from './caller-from-auth.js';
import { rejectionReason, type RejectionReason } from './jwt-verifier.js';

export type GateResult =
  | { readonly ok: true; readonly caller: Caller; readonly expiresAt?: number }
  | { readonly ok: false; readonly response: Response; readonly reason?: RejectionReason };

/** The only place identity enters the MCP endpoint (AUTH-1, AUTH-2). */
export interface BearerGate {
  authenticate(authorization: string | undefined): Promise<GateResult>;
}

/**
 * Verifies the bearer token with the SDK helper (which also enforces expiry and
 * the resource) and answers failures with the SDK's 401 challenge carrying
 * `resource_metadata` (RFC 9728). `reason` is set only when a token was presented.
 */
export function createBearerGate(options: { verifier: OAuthTokenVerifier; resource: URL }): BearerGate {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(options.resource);
  return {
    async authenticate(authorization) {
      try {
        const info = await verifyBearerToken(authorization, {
          verifier: options.verifier,
          expectedResource: options.resource,
          resourceMetadataUrl,
        });
        return { ok: true, caller: callerFromAuthInfo(info), ...(info.expiresAt === undefined ? {} : { expiresAt: info.expiresAt }) };
      } catch (error) {
        const response = bearerAuthChallengeResponse(error, { resourceMetadataUrl });
        const presented = authorization !== undefined && authorization.trim() !== '';
        return { ok: false, response, ...(presented ? { reason: rejectionReason(error) } : {}) };
      }
    },
  };
}
