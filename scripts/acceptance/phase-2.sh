#!/usr/bin/env bash
# Phase 2 acceptance (SPEC section 7, PROGRESS.md):
#   1. two users in different groups see different tool lists
#   2. an out-of-scope call is denied
#   3. the denial is audited with the matching rule
#   4. an invalid YAML file is rejected with file and path
# plus: a fresh clone starts with one command, and an unauthenticated request gets 401
# with resource metadata. Users log in through the real authorization-code + PKCE
# flow of the bundled Keycloak realm. Tests the committed HEAD (a clone sees only
# commits). Prints one PASS/FAIL line per check; exits non-zero if any check fails.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept2-$$"
FAILED=0

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"

compose() { docker compose -p "$PROJECT" "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
mcp() { node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" "$@"; }
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }

echo "# Phase 2 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"
git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# 0. One command from a fresh clone (the bootstrap runs as keycloak-setup).
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  pass stack-healthy "docker compose up -d --build --wait; $(compose logs keycloak-setup 2>/dev/null | grep -o 'keycloak bootstrap done.*' | tail -1)"
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; exit 1
fi

# The endpoint is a protected resource (AUTH-2).
HDRS="$(curl -s -o /dev/null -D - -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP" || true)"
if grep -q '^HTTP/1.1 401' <<<"$HDRS" && grep -qi 'resource_metadata="http://localhost:'"$AIOPS_API_PORT"'/.well-known/oauth-protected-resource/mcp"' <<<"$HDRS"; then
  pass unauthenticated-401 "$(grep -i '^www-authenticate' <<<"$HDRS" | tr -d '\r')"
else
  fail unauthenticated-401 "$HDRS"
fi

# 1. Two users in different groups see different tool lists.
ALICE="$(login alice 2>&1)" || { fail login-alice "$ALICE"; ALICE=""; }
BOB="$(login bob 2>&1)" || { fail login-bob "$BOB"; BOB=""; }
A_TOOLS="$(json "$(mcp --token "$ALICE" --list 2>&1 || true)" '.tools')"
B_TOOLS="$(json "$(mcp --token "$BOB" --list 2>&1 || true)" '.tools')"
if [[ "$A_TOOLS" == '["ping","catalog.search_products"]' && "$B_TOOLS" == '["ping","support.lookup_order"]' ]]; then
  pass different-tool-lists "alice (content): $A_TOOLS; bob (support): $B_TOOLS"
else
  fail different-tool-lists "alice: $A_TOOLS; bob: $B_TOOLS"
fi

# 2. An out-of-scope call is denied.
DENY="$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"initech","fields":["name"]}' 2>&1 || true)"
DENY_TEXT="$(json "$DENY" '.text')"
DENY_CID="$(json "$DENY" '.correlationId')"
if [[ "$(json "$DENY" '.isError')" == "true" && "$DENY_TEXT" == "Denied by policy:"* ]]; then
  pass out-of-scope-denied "$DENY_TEXT"
else
  fail out-of-scope-denied "$DENY"
fi

# 3. The denial is audited with the matching rule.
ROW="$(psql_q "select actor || ' ' || decision || ' ' || (details->>'rule') from audit_event where correlation_id = '${DENY_CID}' and action = 'policy.decision'" 2>&1 || true)"
if [[ -n "$DENY_CID" && "$ROW" == *" deny role:content_manager/grant:own-brands/scope:brand" ]]; then
  pass denial-audited-with-rule "correlation_id=$DENY_CID: $ROW"
else
  fail denial-audited-with-rule "cid=$DENY_CID row=$ROW"
fi

# In scope the same call is allowed by policy and reaches the read path; no credential is stored
# for the development connection, so it ends in the fixed credential_missing text (Phase 3).
ALLOW="$(json "$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"acme","fields":["name"]}' 2>&1 || true)" '.text')"
if [[ "$ALLOW" == *"the credential for its connection has not been entered"* ]]; then pass in-scope-allowed "$ALLOW"; else fail in-scope-allowed "$ALLOW"; fi

# 4. An invalid YAML file is rejected with file and path (CLI shipped in the api image).
mkdir -p "$WORK/broken"
cp deploy/config/*.yaml "$WORK/broken/"
sed -i 's/      - operation: support.lookup_order/      - operation: support.lookup_orders/' "$WORK/broken/roles.yaml"
set +e
OUT="$(compose run --rm --no-deps -T -v "$WORK/broken:/etc/aiops/config:ro" --entrypoint node api \
  node_modules/@aiops/config/dist/cli.js validate /etc/aiops/config 2>&1)"
CODE=$?
set -e
if [[ "$CODE" == 1 ]] && grep -q '^roles.yaml:[0-9]*:[0-9]* roles\[1\]\.grants\[0\]\.operation: ' <<<"$OUT"; then
  pass invalid-yaml-rejected "exit 1: $(head -1 <<<"$OUT")"
else
  fail invalid-yaml-rejected "exit $CODE: $OUT"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
