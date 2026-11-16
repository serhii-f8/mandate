# Spike 2 — Authorization with Keycloak

Throwaway experiment for Phase 0 (de-risks AUTH-1, AUTH-2, AUTH-3; open item 3).
Finding: [docs/reports/phase-0-spike-2-auth-keycloak.md](../../docs/reports/phase-0-spike-2-auth-keycloak.md).
Decision: [docs/decisions/0004-authorization-and-client-registration.md](../../docs/decisions/0004-authorization-and-client-registration.md).

## What is here

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Keycloak 26.8.2 (`start-dev`, `--features=cimd,resource-indicators`), host port 4180 |
| `realm.json` | Realm `spike`: users `alice` (group `content`) and `bob` (group `support`), password `spike-password`; client scopes `mcp:tools` (audience = MCP resource URL) and `groups` (flat `groups` claim), both realm defaults; pre-registered public client `spike-mcp-client`; two clients for negative tests |
| `setup-keycloak.mjs` | Admin REST calls after import: anonymous DCR Trusted Hosts policy, CIMD client profile and client policy |
| `resource-server.mjs` | Protected MCP endpoint on :4111 (`@modelcontextprotocol/server` 2.4.0 + `jose`), tool `whoami` |
| `check.mjs` | Scripted client: discovery, registration (pre-registered / DCR / CIMD), auth code + PKCE with the login form posted over HTTP, token, MCP `whoami`; negative controls. Serves CIMD documents over HTTPS on :4112 |
| `gen-certs.sh` | Throwaway CA + certificate for `host.docker.internal` (CIMD needs an https `client_id`) |
| `run.sh` | Clean start, all assertions, teardown |

## Prerequisites

Docker (Compose v2), Node v22, npm, openssl, curl. Free ports 4111, 4112, 4180.

## Run

```bash
npm ci
./run.sh            # VERBOSE=1 ./run.sh for per-step detail
```

`run.sh` removes any previous `fde-spike-2` containers and volumes, regenerates the
certificates, starts Keycloak, waits until the realm's discovery document answers,
starts the resource server, runs `check.mjs` and tears everything down again.
It prints one `PASS`/`FAIL` line per assertion and exits non-zero on any failure.

Expected today: 30 of 31 pass. `cimd-shape-chatgpt-private-key-jwt` fails by design of
Keycloak 26.8.2 (it rejects any CIMD document containing a property its parser does not
know, here `token_endpoint_auth_methods_supported`); see the finding.

## Run the stack by hand (for manual client tests)

```bash
./gen-certs.sh
docker compose -p fde-spike-2 up -d
node setup-keycloak.mjs
node resource-server.mjs
```

Public-URL variant (tunnel) — see "Manual steps" in the finding for the full procedure:

```bash
export KC_PUBLIC_URL=https://<keycloak-tunnel-host>          # Keycloak --hostname (issuer)
export MCP_RESOURCE=https://<mcp-tunnel-host>/mcp             # audience + PRM resource
docker compose -p fde-spike-2 up -d
MCP_RESOURCE=$MCP_RESOURCE node setup-keycloak.mjs
MCP_RESOURCE=$MCP_RESOURCE KC_ISSUER=$KC_PUBLIC_URL/realms/spike \
  KC_JWKS_URL=http://localhost:4180/realms/spike/protocol/openid-connect/certs \
  node resource-server.mjs
```

## Tear down

```bash
docker compose -p fde-spike-2 down -v
rm -rf .run
```
