# ADR 0009: Offline access in the bundled realm; client registration as observed

- Status: Accepted
- Date: 2026-11-16

Extends [ADR 0004](0004-authorization-and-client-registration.md).

## Context

A manual check in Phase 0 was run on 2026-11-16 with the authorization experiment stack
(`spikes/2-auth-keycloak`) behind two `cloudflared` tunnels, from claude.ai (web) and ChatGPT
(web). Three things happened that ADR 0004 and the scripted checks had not predicted:

1. claude.ai completed the login with its Client ID Metadata Document, then the token
   exchange failed three times with `not_allowed`, "Offline tokens not allowed for the
   user or client". claude.ai asks for `offline_access` in addition to the MCP scope.
   The experiment realm, imported from `realm.json`, gave its users no realm roles and did
   not map the `offline_access` role onto the `offline_access` client scope. Keycloak
   needs both: the user must hold the role, and a client without "Full scope allowed"
   (every CIMD client) only sees the role through the client scope's scope mapping.
   The scripted checks never requested `offline_access`, so they passed.
2. ChatGPT, left on automatic registration, used its Client ID Metadata Document
   (`https://chatgpt.com/oauth/client.json`) and was rejected before the login form
   ("Client not found"; Keycloak log: `not trusted domain: host = chatgpt.com`). The
   parser rejection predicted in ADR 0004 lies behind that and was not reached.
3. ChatGPT with Authentication set to "OAuth or no authentication" reported "The MCP
   server denied access" and never opened the login. Only unauthenticated requests
   reached the server. With Authentication "OAuth", registration method "User-Defined
   OAuth Client", client ID `spike-mcp-client`, no secret, token endpoint auth method
   `none`, the flow completed.

## Options considered

- **A. Leave the realm as it is and tell operators to grant offline access by hand.**
  Rejected: the default installation would fail for Claude at the first connection.
- **B. Remove `offline_access` from the optional client scopes** so Keycloak ignores
  the request. Not tested; whether Claude then works without a refresh token is
  unknown, and a five-minute access token without refresh would force a login every
  few minutes.
- **C. Ship the bundled realm so that users can obtain offline tokens:** realm default
  roles assigned to every user, and the `offline_access` client scope mapped to its
  role. This is what a realm created in the Keycloak console has by default; only a
  hand-written realm import loses it.

## Decision

Option C. AUTH-8 now requires the shipped realm to let a user obtain a refresh token
when the client asks for `offline_access`. Phase 2 builds the bundled realm with the
default roles and the scope mapping and keeps the two `offline-access-*` assertions as
tests.

Client registration stays as ADR 0004 decided: Claude through CIMD, ChatGPT through a
pre-registered public client. The installation documentation (NFR-13, Phase 10) must
give the exact ChatGPT settings from point 3 above, because the default settings fail.

## Consequences

- Offline tokens do not expire with the SSO session. Their lifetime and revocation in
  the bundled realm (offline session idle and max) must be set deliberately in
  Phase 2; this ADR does not choose values.
- With default roles, tokens of clients that do not send a `resource` parameter carry
  the extra audience `account`. Tokens issued for the MCP resource still carry exactly
  that resource as audience (assertions `*-audience-is-resource`).
- The MCP server refuses every unauthenticated request, so it cannot be added in
  ChatGPT's mixed "OAuth or no authentication" mode. That is intended (SEC-1).

## Verified

- Manual, 2026-11-16, claude.ai web and ChatGPT web, the experiment stack behind `cloudflared`
  2026.11.0 tunnels, Keycloak 26.8.2. Resource server log: 13 accepted requests with
  `sub` of `alice` and `client=https://claude.ai/oauth/mcp-oauth-client-metadata`;
  3 accepted requests with `sub` of `bob` and `client=spike-mcp-client`. Keycloak log:
  three `CODE_TO_TOKEN_ERROR … reason="Offline tokens not allowed for the user or
  client"` for the Claude client before the fix, none after; three `LOGIN_ERROR …
  clientId="https://chatgpt.com/oauth/client.json" … error="client_not_found"`.
  `whoami` in claude.ai returned `preferred_username: alice`, `groups: content`,
  `client_id: https://claude.ai/oauth/mcp-oauth-client-metadata`; in ChatGPT
  `"preferred_username": "bob"`, `"groups": ["support"]`, `"client_id": "spike-mcp-client"`
  (screenshots, 2026-11-16). The client versions were not recorded.
- Experiment, 2026-11-16: `bash spikes/2-auth-keycloak/run.sh`. Before the realm change,
  with the two new assertions: `30/33`, both `offline-access-*` FAIL with the same
  error text as the live run. After: `32/33`, both PASS with
  `refresh_token typ=Offline`; the remaining FAIL is the known ChatGPT CIMD shape.
- The cause of point 3 is inferred from the server log and from the flow succeeding
  after the setting changed; ChatGPT's own behaviour in that mode was not inspected.
