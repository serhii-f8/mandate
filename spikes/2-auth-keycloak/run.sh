#!/usr/bin/env bash
# Spike 2 end-to-end check. Starts from clean state, runs all assertions, tears down.
# Prints one PASS/FAIL line per assertion; exits non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")"

PROJECT=fde-spike-2
export MCP_RESOURCE="${MCP_RESOURCE:-http://localhost:4111/mcp}"
export KC_URL="${KC_URL:-http://localhost:4180}"
RS_LOG=.run/resource-server.log
RS_PID=

cleanup() {
  [ -n "$RS_PID" ] && kill "$RS_PID" 2>/dev/null
  docker compose -p "$PROJECT" down -v >/dev/null 2>&1
}
trap cleanup EXIT

# 1. Clean state: no containers/volumes from a previous run, fresh certificates.
docker compose -p "$PROJECT" down -v >/dev/null 2>&1
rm -rf .run
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
./gen-certs.sh

# 2. Keycloak: start and wait until the imported realm serves its discovery document.
docker compose -p "$PROJECT" up -d >/dev/null 2>&1 || { echo "FAIL keycloak-start"; exit 1; }
ready=
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "$KC_URL/realms/spike/.well-known/openid-configuration"; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "FAIL keycloak-ready"; docker compose -p "$PROJECT" logs --tail 50; exit 1; }
echo "keycloak $(docker compose -p "$PROJECT" exec -T keycloak /opt/keycloak/bin/kc.sh --version 2>/dev/null | grep -m1 -i '^keycloak' || echo 'version unknown') ready"

# 3. Resource server, wait for health.
node resource-server.mjs >"$RS_LOG" 2>&1 &
RS_PID=$!
ready=
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null http://localhost:4111/healthz; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { echo "FAIL resource-server-ready"; cat "$RS_LOG"; exit 1; }

# 4. Assertions.
node check.mjs
status=$?
exit $status
