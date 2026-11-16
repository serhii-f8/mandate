import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Fixed, value-free reasons recorded in `auth.rejected` events (AUD-1). */
export const REJECTION_REASONS = ['expired', 'invalid_signature', 'invalid_issuer', 'invalid_audience', 'malformed'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

const ALGORITHMS = ['RS256', 'PS256', 'ES256'];

function reasonOf(error: unknown): RejectionReason {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWKSNoMatchingKey) return 'invalid_signature';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'invalid_issuer';
    if (error.claim === 'aud') return 'invalid_audience';
  }
  return 'malformed';
}

/** The reason carried by an `OAuthError` this verifier threw; `malformed` for anything else. */
export function rejectionReason(error: unknown): RejectionReason {
  if (error instanceof OAuthError) {
    const found = REJECTION_REASONS.find((r) => error.message === `token rejected: ${r}`);
    if (found !== undefined) return found;
  }
  return 'malformed';
}

/**
 * Validates access tokens for this MCP resource (AUTH-1, ADR 0014): signature
 * against the issuer's JWKS, issuer, audience equal to the canonical MCP URL,
 * expiry with no clock tolerance, and a subject. The returned `AuthInfo` never
 * carries the token itself (AUTH-7).
 */
export function createJwtVerifier(options: { issuer: string; audience: string; jwks: JWTVerifyGetKey }): OAuthTokenVerifier {
  const resource = new URL(options.audience);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, options.jwks, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALGORITHMS,
          requiredClaims: ['exp', 'sub', 'iss', 'aud'],
          clockTolerance: 0,
        }));
      } catch (error) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `token rejected: ${reasonOf(error)}`);
      }
      const { sub, exp, azp, groups } = payload;
      if (typeof sub !== 'string' || sub === '' || typeof exp !== 'number') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'token rejected: malformed');
      }
      return {
        token: '',
        clientId: typeof azp === 'string' ? azp : '',
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter((s) => s !== '') : [],
        expiresAt: exp,
        // jose has verified that `aud` contains exactly this value.
        resource,
        extra: { sub, groups },
      };
    },
  };
}
