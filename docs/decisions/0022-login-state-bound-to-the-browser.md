# ADR 0022: Login state is bound to the browser

- Status: Accepted
- Date: 2026-11-16

Amends [ADR 0019](0019-credential-vault-and-trusted-page-sessions.md).

## Context

ADR 0019 stores the OIDC `state`, nonce and PKCE verifier server-side under the hash of
`state`. A review of the page login found that this alone permits login CSRF: an attacker
starts a login in their own browser, signs in, stops before the callback, and makes the
victim's browser open `/auth/callback?state=S&code=C`. The callback finds the row by
`state`, PKCE and nonce match (they are the attacker's), and the victim gets a session as
the attacker. Anything the victim then enters on a trusted page (a credential) is
attributed to the attacker in audit (AUD-1). RFC 9700 (OAuth 2.0 Security Best Current
Practice) requires the client to bind `state` (or PKCE) to the user agent.

## Options considered

1. Accept the risk (single-tenant identity provider, write-only vault).
2. A short-lived cookie carrying the state, checked at the callback.
3. Store a separate browser-binding value in `web_login` (schema change).

## Decision

Option 2. `/auth/login` sets `mandate_login=<state>` (`HttpOnly; SameSite=Lax;
Path=/auth/callback; Max-Age=600`, `Secure` on https). The callback requires it to equal
the `state` parameter (constant-time) before consuming the login row and clears it in
every outcome. `SameSite=Lax` is needed because the callback is a cross-site top-level
GET from the identity provider in production. One login at a time per browser: a
second login started in another tab replaces the cookie, and the first tab's callback
then fails and starts over.

## Consequences

- No migration; the state is already a 256-bit random value.

## Verified

The e2e tests of the page login (`apps/api/test/e2e/page-auth.e2e.test.ts`): a callback
with a valid state but no cookie, or another login's cookie, is refused with an
`auth.login` error row; the normal flow passes with the test issuer and with Keycloak
26.8.2 (`keycloak.e2e.test.ts`).
