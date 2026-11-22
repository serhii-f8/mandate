# ADR 0014: Token verification, protected resource metadata and the realm bootstrap

- Status: Accepted
- Date: 2026-11-16

## Context

Phase 2 turns the MCP endpoint into an OAuth 2.1 resource server (AUTH-1, AUTH-2),
reads groups from the token (AUTH-3), never forwards the token (AUTH-7), and ships the
bundled realm's registration policy with PKCE S256 for every client (AUTH-8).
[ADR 0004](0004-authorization-and-client-registration.md) fixed the Keycloak side in principle; the Phase 0 authorization experiment
left four things to Phase 2: the verifier (without the experiment's hard-coded resource), a
PKCE enforcer for DCR and CIMD clients (untested in the experiment), an idempotent bootstrap
for settings a realm import cannot toggle, and the offline-session lifetimes
([ADR 0009](0009-offline-access-and-observed-client-registration.md)).

## Options considered

1. **Verifier:** SDK bearer helpers with a `jose` verifier; a NestJS guard with our own
   challenge; token introspection at Keycloak per request.
2. **JWKS location:** derived from discovery at start; a required `OIDC_JWKS_URL`.
3. **Clock tolerance:** 0; 30–60 s.
4. **Protected resource metadata:** the SDK's `oauthMetadataResponse` (needs the AS
   metadata and also serves `/.well-known/oauth-authorization-server`); a hand-written
   document served by a controller.
5. **Authentication audit:** every request; rejected tokens only; nothing.
6. **Settings a realm import cannot toggle (client policies, DCR policy):** realm-file
   `clientPolicies`/`clientProfiles` plus a separate DCR switch; one bootstrap script
   for all of them via the Admin REST API.
7. **PKCE for every client:** per-client attribute (pre-registered only); a client
   policy `pkce-enforcer` with condition `any-client`.
8. **Offline sessions:** Keycloak defaults (idle 30 days, no maximum); idle 7 days with
   a 30-day maximum.

## Decision

1. SDK helpers: `verifyBearerToken` + `bearerAuthChallengeResponse` from
   `@modelcontextprotocol/server` 2.4.0, verifier on `jose` 6 (`jwtVerify`, remote
   JWKS, issuer, audience = canonical MCP URL, `RS256`/`PS256`/`ES256`, required `exp`,
   `sub`, `iss`, `aud`). `AuthInfo.resource` is set to the canonical URL only after
   jose has verified the audience, so the SDK's `expectedResource` comparison is a real
   second check rather than a constant. No introspection (one less call per
   request; revocation within the 5-minute token lifetime is accepted).
2. `OIDC_ISSUER`, `OIDC_JWKS_URL` and `MANDATE_MCP_RESOURCE` are required environment
   variables. The issuer is a public URL that `api` may not reach inside Compose, and a
   discovery fetch at start would add a failure mode for no gain.
3. Clock tolerance 0, as in the Phase 0 experiment; `api` and Keycloak share a host clock in
   the standard installation.
4. Hand-written metadata at the root and path-suffixed well-known URLs: the document is
   five fields, and `api` must not answer as an authorization server.
5. Rejected tokens only (`auth.rejected`, reason only). Missing tokens are the normal
   discovery step of every client and would flood the append-only table.
6. One bootstrap, [`deploy/keycloak/bootstrap.mjs`](../../deploy/keycloak/bootstrap.mjs), run
   as Compose one-shot service `keycloak-setup` and by the tests. It owns the realm's client
   profiles and policies and replaces them on every run, and it switches anonymous DCR between
   Keycloak's shipped Trusted Hosts config (`MANDATE_DCR=off`, default) and "redirect-URI hosts
   must be in `MANDATE_DCR_REDIRECT_HOSTS`" (`on`).
7. Policy `mandate-pkce-all`: condition `any-client`, profile with executor
   `pkce-enforcer` (`auto-configure: true`).
8. Offline sessions: idle 604800 s (7 days), maximum lifespan enabled at 2592000 s
   (30 days), set in the realm file.

Also: the pre-registered client `mandate-mcp` gets the fixed Claude Code loopback
redirect `http://localhost:33418/callback` (and `127.0.0.1`), which ADR 0004 asked for;
tests and the acceptance script log in through it. Tests that need a CIMD client serve
the document over plain HTTP and set the test-only `MANDATE_CIMD_ALLOW_HTTP=true`; the
shipped default stays `false`.

## Consequences

- An operator who edits client policies in the Keycloak console loses the edits on the
  next bootstrap run; installation documentation (Phase 10) must say so.
- Okta or Entra installations set `OIDC_ISSUER`/`OIDC_JWKS_URL` and must emit a flat
  `groups` claim and the MCP URL as audience; the bootstrap is Keycloak-only.
- Tokens stay valid until `exp` after a user is disabled (no introspection).
- A user who does not reconnect for 7 days, or after 30 days in any case, logs in again.

## Verified

2026-11-16:

- `@modelcontextprotocol/server@2.4.0`, `dist/index.d.mts` lines 63–176:
  `OAuthTokenVerifier`, `verifyBearerToken(header, { verifier, requiredScopes,
  resourceMetadataUrl, expectedResource })` ("rejects tokens whose `AuthInfo.expiresAt`
  is unset"; resource compared as strings ignoring a fragment and one trailing slash),
  `bearerAuthChallengeResponse` (401 `invalid_token` with `resource_metadata`).
- Experiment with `quay.io/keycloak/keycloak:26.8.2`, `start-dev --import-realm
  --features=cimd,resource-indicators`, the Phase 1 realm file (throwaway scripts against the
  Admin REST API and the authorization endpoint):
  - `/admin/serverinfo` lists executor `pkce-enforcer` (property `auto-configure`,
    boolean) and condition `any-client` (property `is-negative-logic`);
  - the realm's anonymous Trusted Hosts component ships with
    `{"host-sending-registration-request-must-match":["true"],"client-uris-must-match":["true"]}`;
  - realm defaults `offlineSessionIdleTimeout` 2592000, max lifespan disabled;
  - with policy `any-client` → `pkce-enforcer`, an authorization request **without**
    `code_challenge` is answered
    `302 …error=invalid_request&error_description=Missing+parameter:+code_challenge_method`
    and one with `plain` `…code+challenge+method+is+not+matching+the+configured+one`,
    for the pre-registered client `mandate-mcp`, a client registered anonymously through
    DCR (201) and a CIMD client (document fetched over HTTP with
    `cimd-allow-http-scheme: true`); with S256 all three get the login form; the DCR
    client was stored with `pkce.code.challenge.method=S256`.
