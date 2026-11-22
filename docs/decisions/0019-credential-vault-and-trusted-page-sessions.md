# ADR 0019: Credential vault and trusted-page sessions

- Status: Accepted
- Date: 2026-11-16

## Context

SEC-2 needs envelope-encrypted credentials with key rotation, decrypted only inside
adapter calls; UI-5 a credential entry page that is never a widget; AUTH-5 OIDC login for
pages against the bundled Keycloak; SEC-8 a fresh session and CSRF protection for
credential actions; SEC-1 authorization of every page request; NFR-3 any `api` instance
serving any page request.

## Options considered

1. **Session model:** PostgreSQL rows with an opaque cookie; encrypted stateless cookie;
   tokens in the browser (public client).
2. **OIDC client:** public client with PKCE; confidential client (`mandate-web`) with PKCE.
3. **Fresh session:** step-up only by time since `auth_time`; plus `acr` levels.
4. **Encryption:** envelope encryption (per-record data key, master key from env);
   `pgcrypto`; a single key encrypting values.
5. **Who may enter credentials:** any logged-in user; a role field naming refs.
6. **Where the page lives:** `packages/widgets`; `apps/web` served by `api` on the same
   origin; a separate web server.

## Decision

1. **PostgreSQL sessions** (`web_session`, key = SHA-256 of a random 256-bit cookie value;
   `web_login` for state, nonce and PKCE verifier, single use). Revocable, readable by
   any instance, no token in the browser.
2. **Confidential `mandate-web`** with PKCE S256 and a client-level groups mapper on the
   ID token; the secret comes from `MANDATE_WEB_CLIENT_SECRET` (development default
   `dev-only-…`). The code is exchanged at the internal token URL; the ID token's issuer
   is the public URL. No access or refresh token is kept.
3. **Time since `auth_time`** (`MANDATE_FRESH_AUTH_SECONDS`, default 300); re-login with
   `prompt=login&max_age=0`. AUTH-6 (Phase 6) reuses the mechanism.
4. **Envelope encryption**, AES-256-GCM twice (value under a data key with AAD bound to
   ref and scheme; data key under the master key with AAD bound to ref and key version).
   `MANDATE_MASTER_KEYS` holds versioned keys; the highest is current; `mandate credentials
   rotate` re-wraps data keys. A `KeyProvider` interface leaves room for KMS.
5. **`manage_credentials: [ref | "*"]`** on roles, mapped from groups like every grant.
6. **`apps/web`** (React + Vite) served by `api` under `/app/`, REST under `/api/v1`, so
   cookies are `SameSite=Strict` and there is no CORS. Not in `packages/widgets`, so no
   widget bundle can include the credential form (UI-5).

Every route is denied unless marked `@Public()` or `@PageAccess(...)`; a test enumerates
the routes. Mutations require `X-CSRF-Token` (synchroniser token in the session) and an
`Origin` equal to `MANDATE_PUBLIC_URL`.

[ADR 0022](0022-login-state-bound-to-the-browser.md) amends this decision: the login state is also bound to the browser.

## Consequences

- The development stack gains a user `carol` in group `admins` with role
  `integration_admin`, and Keycloak needs `MANDATE_WEB_CLIENT_SECRET`.
- Sessions survive an `api` restart and a switch between instances; logout or row
  expiry ends them.
- Losing every master key loses every credential; NFR-13 backup documentation (Phase 10)
  must say to back up `MANDATE_MASTER_KEYS` separately from the database.
- The `api` image now contains the built `web` bundle.

## Verified

2026-11-16, throwaway experiment with `quay.io/keycloak/keycloak:26.8.2`
(digest `sha256:c68e286c…bbf0`), `--hostname=http://localhost:18480`, on a Docker network:
- authorization through the public URL, code exchange from another container at
  `http://keycloak:8080/realms/mandate/protocol/openid-connect/token` with
  `client_secret_basic` and `client_secret_post`: 200; ID token `iss` =
  `http://localhost:18480/realms/mandate` (public), `aud` = `azp` = `mandate-web`, `auth_time`,
  `nonce`, `sid` and `groups` present (`["admins"]`, `["content"]`);
- with an SSO cookie: no parameters → no login form, `auth_time` unchanged; `max_age=0` and
  `prompt=login` → login form, `auth_time` increased;
- the client attribute `pkce.code.challenge.method=S256` refuses a missing or `plain`
  challenge; after `deploy/keycloak/bootstrap.mjs` the `pkce-enforcer` restores the
  attribute when removed;
- `${MANDATE_WEB_CLIENT_SECRET}` in the realm file is substituted at import (right secret
  200, wrong secret `401 unauthorized_client`);
- logout endpoint with `id_token_hint` and a registered `post_logout_redirect_uri`
  redirects without confirmation; an unregistered one gets 400.
