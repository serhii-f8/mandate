#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Phase 1 acceptance (SPEC section 7, PROGRESS.md):
#   1. a fresh clone starts with one command
#   2. an MCP client calls the tool
#   3. the call appears in audit
# plus: the worker runs its workflow, Keycloak serves the realm, and a second start
# on the same volumes works. Tests the committed HEAD (a clone sees only commits).
# Prints one PASS/FAIL line per check; exits non-zero if any check fails.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout
# (for the MCP client used as the tester's tool).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept-$$"
FAILED=0

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
export AIOPS_MAILPIT_PORT="$(free_port)"  # Compose runs Mailpit since Phase 6; a fixed port breaks parallel runs
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"

compose() { docker compose -p "$PROJECT" "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }

echo "# Phase 1 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"
git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# 1. One command from a fresh clone.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  pass stack-healthy "docker compose up -d --build --wait"
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; exit 1
fi

# Since Phase 2 the endpoint is a protected resource: log in as a development user.
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" alice dev-only-password "$AIOPS_MCP_RESOURCE"; }
TOKEN="$(login 2>&1)" || { fail login "$TOKEN"; TOKEN=""; }

# 2. An MCP client calls the tool.
if CALL="$(node "$REPO/tooling/acceptance/mcp-call.mjs" "http://127.0.0.1:${AIOPS_API_PORT}/mcp" accept --token "$TOKEN" 2>&1)"; then
  pass mcp-ping "$CALL"
else
  fail mcp-ping "$CALL"
fi
CID="$(node -e "try{console.log(JSON.parse(process.argv[1]).correlationId??'')}catch{console.log('')}" "${CALL:-}")"

# 3. The call appears in audit.
ROWS="$(compose exec -T postgres psql -U aiops -d aiops -tAc \
  "select count(*) from audit_event where correlation_id = '${CID}' and action = 'tool.call' and subject = 'ping' and outcome = 'ok'" 2>&1 || true)"
if [[ -n "$CID" && "$ROWS" == "1" ]]; then pass audit-row "correlation_id=$CID"; else fail audit-row "rows=$ROWS cid=$CID"; fi

# Worker runs the trivial workflow. Since Phase 5 every payload is encrypted (SEC-4), so the
# workflow is started from the worker image with the codec, not with the plaintext Temporal CLI.
WF="$(compose exec -T worker node dist/smoke-cli.js accept 2>&1 || true)"
if grep -q '"echoed":"accept"' <<<"$WF"; then pass smoke-workflow "COMPLETED {\"echoed\":\"accept\"}"; else fail smoke-workflow "$(tail -5 <<<"$WF")"; fi

# Keycloak serves the realm.
ISSUER="$(curl -sf "http://127.0.0.1:${AIOPS_KEYCLOAK_PORT}/realms/aiops/.well-known/openid-configuration" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).issuer)}catch{console.log('')}})" || true)"
if [[ "$ISSUER" == */realms/aiops ]]; then pass keycloak-realm "issuer=$ISSUER"; else fail keycloak-realm "issuer=$ISSUER"; fi

# A second start on the same volumes works and the endpoint still answers.
if compose down >/dev/null 2>&1 && compose up -d --wait >"$WORK/up2.log" 2>&1 \
  && TOKEN="$(login 2>/dev/null)" \
  && node "$REPO/tooling/acceptance/mcp-call.mjs" "http://127.0.0.1:${AIOPS_API_PORT}/mcp" again --token "$TOKEN" >/dev/null 2>&1; then
  pass restart "down + up -d --wait, ping answered"
else
  fail restart "$(tail -20 "$WORK/up2.log" 2>/dev/null)"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
