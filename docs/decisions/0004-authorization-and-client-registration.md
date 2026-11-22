# ADR 0004: Authorization server, client registration and token audience

- Status: Accepted
- Date: 2026-11-16

## Context

The MCP endpoint is an OAuth 2.1 resource server and the platform bundles Keycloak as its default
authorization server ([SPEC](../SPEC.md) section 3; AUTH-1, AUTH-2, AUTH-3). MCP revision
2026-07-28 defines three ways for a client to get a client ID — Client ID Metadata Documents (CIMD,
SHOULD), pre-registration, and Dynamic Client Registration (DCR, MAY, now deprecated) — with client
preference pre-registered → CIMD → DCR. It requires the `resource` parameter (RFC 8707) in
authorization and token requests and requires the server to accept only tokens issued for it.
Claude (claude.ai, Desktop, mobile, Code) and ChatGPT document all three methods; Claude picks CIMD
when the AS advertises it with public-client support, ChatGPT prefers CIMD when advertised (vendor
docs).

Phase 0 spike 2 ran all three methods end to end against Keycloak 26.8.2 with a scripted client:
all pass; replicas of the Claude Desktop and Claude Code CIMD documents pass; the ChatGPT CIMD
document is rejected because Keycloak's metadata parser fails on the unknown property
`token_endpoint_auth_methods_supported`. Keycloak does not create an audience from `resource`; it
only validates and narrows an audience that a mapper already put in the token. In a fresh realm
anonymous DCR is blocked by the Trusted Hosts policy, and DCR clients are not PKCE-enforced.

## Options considered

1. **Registration defaults**
   a. DCR on for everyone (what most MCP-server guides did before 2026-07-28).
   b. Pre-registered clients plus CIMD on; DCR off by default, opt-in.
   c. Pre-registered clients only.
2. **Keycloak features:** none (stable only) vs `cimd` and/or `resource-indicators` (both
   experimental in 26.8.2).
3. **Audience binding**
   a. `resource` parameter alone (not possible in Keycloak).
   b. Audience mapper with a custom audience equal to the MCP URL, in a realm-default client scope,
      plus `resource-indicators` for validation and narrowing.
   c. A client representing the MCP server with the `resource_url` attribute, targeted by a
      client-audience mapper on every client.
   d. Optional scope the client must request (Keycloak guide's method without RFC 8707).
4. **Groups claim:** group-membership mapper in a default client scope vs per-client mappers vs
   roles instead of groups.

## Decision

- **Keycloak version and flags:** `quay.io/keycloak/keycloak:26.8.2` (current stable on
  2026-11-16; pin the minor, re-run the spike check before any upgrade), started with
  `--features=cimd,resource-indicators` and `--hostname=<public https URL of Keycloak>`.
  Production uses `start` (not `start-dev`) with TLS or a TLS-terminating proxy.
- **Registration methods enabled by default:**
  - **Pre-registered:** one public client (PKCE S256 required) whose redirect URIs cover
    `https://claude.ai/api/mcp/auth_callback`,
    `https://chatgpt.com/connector_platform_oauth_redirect`,
    `https://chatgpt.com/connector/oauth/*` and a fixed Claude Code loopback port. This is the
    documented path for ChatGPT ("static credentials").
  - **CIMD:** on. Client profile with the `client-id-metadata-document` executor
    (`cimd-allow-http-scheme=false`, trusted domains `claude.ai`, `localhost`, `127.0.0.1`,
    restrict-same-domain off, public clients allowed, "accept public client with confidential-only
    grant types" on, resource-indicator allow list = the MCP URL) and a client policy with the
    `client-id-uri` condition (scheme `https`, domain `claude.ai`). Both trusted-domain lists are
    configuration. The feature flag and the policy are always configured together: the flag alone
    already advertises `client_id_metadata_document_supported: true`, and URL client IDs then fail
    with "Client not found".
  - **DCR:** off by default (Keycloak's default anonymous Trusted Hosts policy, which rejects every
    anonymous registration). An operator switch enables it by setting Trusted Hosts to "any sender,
    redirect URI hosts must be in the list" (default list `claude.ai`, `chatgpt.com`, `localhost`,
    `127.0.0.1`), keeping Keycloak's other anonymous policies (consent required, full scope
    disabled, max clients, allowed scopes and mappers), and a realm client policy with
    `pkce-enforcer`.
- **Audience binding (AUTH-1):** realm-default client scope `mcp:tools` with an audience mapper,
  `included.custom.audience` = the canonical MCP URL (from configuration, also the `resource` in
  the protected resource metadata and its `scopes_supported`). `resource-indicators` makes Keycloak
  reject any other `resource` with `invalid_target` and narrow `aud` to exactly the requested
  resource. The resource server accepts a token only if `aud` contains its canonical URL, the
  signature verifies against the realm JWKS, `iss` matches, and `exp` has not passed. The token
  request's `resource` is thus validated, but the audience itself always comes from the mapper.
- **Groups (AUTH-3):** realm-default client scope `groups` with the group-membership mapper: claim
  `groups`, `full.path=false`, access token (and userinfo/introspection), not the ID token. The
  role mapping in configuration matches group names. Realms with nested groups of equal names
  switch to `full.path=true` and map paths.
- **Realm provisioning:** realm import file with `${ENV}` placeholders for URLs; it lists the
  built-in OIDC client scopes explicitly (a realm file that lists any client scope otherwise loses
  `basic`, i.e. `sub`). DCR policy and client policies are applied by an idempotent bootstrap
  through the Admin REST API.

## Consequences

- Claude (claude.ai, Desktop, Code) can connect with zero setup through CIMD; Claude only falls
  back to DCR when CIMD is not advertised, so DCR off does not affect it (vendor docs; real clients
  not yet observed).
- ChatGPT cannot use CIMD with Keycloak 26.8.2. Because CIMD is advertised, ChatGPT will prefer it
  unless the person creating the connector enters the pre-registered client ID (or the operator
  enables DCR and the creator picks it). Setup documentation must say so. Revisit when Keycloak
  tolerates unknown metadata properties or ships a CIMD provider that normalises them.
- Two experimental Keycloak features are in the default deployment. If either breaks, the fallback
  is: drop `resource-indicators` (audience still bound by the mapper and enforced by the resource
  server; only `resource` validation is lost) and/or drop `cimd` (Claude then needs DCR or a client
  ID).
- Every client in the realm gets the MCP audience (default scope). The realm is dedicated to the
  platform, so this is accepted; other applications belong in other realms.
- The hosted clients need the MCP endpoint and Keycloak reachable over public HTTPS, Keycloak's
  discovery and token endpoints from Anthropic's egress range as well.
- Phase 2 builds the token verifier and the Keycloak bootstrap from the spike's
  `resource-server.mjs` and `setup-keycloak.mjs`, and adds the PKCE-enforcer policy.

## Verified

- Automated, 2026-11-16, `spikes/2-auth-keycloak/run.sh` (Docker Desktop, WSL2), Keycloak 26.8.2
  image digest `sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0`: 30 of 31
  assertions pass — full flow, exact audience and groups claim for pre-registered, DCR and CIMD;
  Claude Desktop and Claude Code CIMD document shapes; `private_key_jwt` CIMD control; negative
  controls (no token, wrong audience, expired, tampered signature, unknown resource, resource
  without audience mapper). FAIL: ChatGPT CIMD document shape.
- From documents, 2026-11-16: MCP 2026-07-28 authorization pages; Keycloak MCP guide; Keycloak
  26.8.2 source (`ResourceIndicatorsPostProcessor`, `AbstractClientIdMetadataDocumentExecutor`);
  Claude connector authentication docs, Claude Code MCP docs; OpenAI plugin authentication and
  custom MCP server docs; the published CIMD documents of Claude, Claude Code and ChatGPT.
- **Pending manual verification** at the time of the decision: Claude (claude.ai web or Desktop)
  via CIMD, pre-registered client and DCR; Claude Code via CIMD; ChatGPT via pre-registered client
  (including whether it accepts a public client without secret and which redirect URI it shows),
  via DCR, and confirmation that its CIMD attempt fails as predicted; the MCP protocol version each
  client sends.

## Addendum 2026-11-16: registration policy recorded as AUTH-8

The default registration policy decided here is recorded in [SPEC](../SPEC.md) as a new
requirement, **AUTH-8**, assigned to Phase 2. Open item 3 of SPEC section 8 stays open until Claude
Desktop and ChatGPT have been observed.
