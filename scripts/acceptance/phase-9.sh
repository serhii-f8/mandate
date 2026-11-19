#!/usr/bin/env bash
# Phase 9 acceptance (SPEC section 7, designs phase-9-mcp-upstream*) against two MCP upstreams on
# the Compose network: the reference server `everything` (@modelcontextprotocol/server-everything
# 2.2.1) and the fake MCP server of packages/testing, whose tools change at run time:
#   stack-healthy;
#   group 1, MCP upstream attach, grants and pinning (CONN-1, CONN-4, SEC-5, SEC-6): mcp-attach,
#   mcp-enable-grants, mcp-sec6, mcp-sec5, mcp-pin-changed, mcp-repin. It attaches both servers
#   with `mcp.yaml` and no operations (every tool disabled, CONN-1), binds three operations with the
#   pins `aiops mcp tools` shows and grants them, checks that bob sees only the configured text
#   (SEC-6) and alice no image or base64 (SEC-5), changes the fake's tool and sees the operation
#   refused and audited, then records the new pin and sees it offered again, all without a restart
#   of the api or the worker.
# AIOPS_ACCEPT9_GROUPS selects the groups (default "1"); a selected group that is not defined is a
# FAIL (ADR 0043).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that mounts a
# generated configuration and adds the two MCP containers. No Magento sandbox.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: pulls node:24-bookworm-slim and fetches the everything server with npx.
# Secrets: access tokens travel through variables and the environment of node only, never argv.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
# The functions run through the trap and the group dispatch, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept9-$$"
FAILED=0

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
AIOPS_MAILPIT_PORT="$(free_port)" AIOPS_FAKE_MCP_PORT="$(free_port)"
export AIOPS_API_PORT AIOPS_KEYCLOAK_PORT AIOPS_TEMPORAL_PORT AIOPS_POSTGRES_PORT AIOPS_MAILPIT_PORT AIOPS_FAKE_MCP_PORT
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
FAKE="http://127.0.0.1:${AIOPS_FAKE_MCP_PORT}"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-9.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(v===undefined?'':typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
# A user runs mcp-call.mjs with the given flags; the user logs in again before every call, so no
# token expires during the run.
user_client() {
  local user="$1" token
  shift
  token="$(login "$user" 2>&1)" || { echo "{\"loginError\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$token")}"; return 0; }
  AIOPS_MCP_TOKEN="$token" node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" "$@" 2>&1 || true
}
user_mcp() { user_client "$1" --tool "$2" --args "$3"; }
# Whether the user lists the tool: yes|no.
lists() { [[ "$(json "$(user_client "$1" --list)" ".tools.includes(\"$2\")")" == true ]] && echo yes || echo no; }
# Polls `lists USER TOOL` every 2 s for at most 60 s until it answers WANT (yes|no). Returns 1 on timeout.
await_listed() {
  local deadline=$((SECONDS + 60))
  while :; do
    [[ "$(lists "$1" "$2")" == "$3" ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q "$1")"; }
cli() { compose exec -T api node dist/cli.js "$@"; }
apply_config() { cli config apply /etc/aiops/config --actor acceptance 2>&1; }
# The hash of the tool in `mcp tools` output (`<tool> <hash> <operation|-> <state|unreferenced>`).
hash_of() { sed -n "s/^$2 \(sha256:[0-9a-f]\{64\}\) .*$/\1/p" <<<"$1" | head -1; }

# roles.yaml as in phase-8.sh (alice content, bob support), with extra grants for support_agent ($1)
# and content_manager ($2), each a list of flow-mapping lines.
write_roles() {
  cat >"$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" <<YAML
version: 1
notifications:
  - { id: content-leads-mail, kind: email, to: [content-leads@example.test] }
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, id: own-brands, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
      - { operation: catalog.update_content, id: own-brands-content, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
${2}
    approval: { required: above_threshold, record_threshold: 2, steps: [{ role: content_lead }], allow_widget: false }
  - id: content_lead
    grants: []
    notify: { approval_requests: [content-leads-mail] }
  - id: support_agent
    grants:
      - { operation: support.lookup_order }
${1}
  - { id: integration_admin, grants: [], manage_credentials: [magento-integration] }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: content-leads, roles: [content_lead] }
  - { group: support, roles: [support_agent] }
  - { group: admins, roles: [integration_admin] }
YAML
}

# mcp.yaml: both connections; with pins ($1 echo, $2 get-tiny-image, $3 lookup) also the operations.
write_mcp() {
  cat >"$AIOPS_ACCEPT_CONFIG_DIR/mcp.yaml" <<'YAML'
version: 1
connections:
  - id: everything
    adapter: mcp
    mcp_url: http://mcp-everything:3001/mcp
    allow_private_network: true
    pin_check_seconds: 10
  - id: fakemcp
    adapter: mcp
    mcp_url: http://mcp-fake:3002/mcp
    allow_private_network: true
    pin_check_seconds: 10
YAML
  (($# == 0)) && return 0
  cat >>"$AIOPS_ACCEPT_CONFIG_DIR/mcp.yaml" <<YAML
operations:
  - id: everything.echo
    connection: everything
    risk: read
    description: Echo a message back.
    upstream: { tool: echo, pin: '$1' }
  - id: everything.tiny_image
    connection: everything
    risk: read
    description: Return a small test image.
    upstream: { tool: get-tiny-image, pin: '$2' }
  - id: fakemcp.lookup
    connection: fakemcp
    risk: read
    description: Look up a record.
    upstream: { tool: lookup, pin: '$3' }
YAML
}

GRANTS_SUPPORT='      - { operation: everything.echo }'
GRANTS_CONTENT='      - { operation: everything.tiny_image }
      - { operation: fakemcp.lookup }'

echo "# Phase 9 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT, fake MCP port $AIOPS_FAKE_MCP_PORT)"

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# The base configuration: deploy/config with the acceptance roles, and no MCP connection.
mkdir -p "$AIOPS_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$AIOPS_ACCEPT_CONFIG_DIR/"
if grep -lE 'adapter: mcp' "$AIOPS_ACCEPT_CONFIG_DIR"/*.yaml >/dev/null; then
  fail acceptance-config "the development configuration already has an mcp connection"; exit 1
fi
write_roles "" ""

# One command from a fresh clone; both MCP containers healthy.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  health="$(for s in mcp-everything mcp-fake; do docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q "$s")"; done | xargs)"
  if [[ "$health" == "healthy healthy" ]]; then
    pass stack-healthy "docker compose up -d --build --wait; mcp-everything and mcp-fake: $health"
  else
    fail stack-healthy "mcp-everything and mcp-fake: $health"; compose ps -a; exit 1
  fi
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api worker mcp-everything mcp-fake | tail -40; exit 1
fi

# ---- Group 1: MCP upstream attach, grants and pinning (CONN-1, CONN-4, SEC-5, SEC-6) ------------

group_1() {
  local started_api started_worker apply apply_code tools fake_tools echo_pin image_pin lookup_pin new_pin list
  local stamp_1 echo_answer alice_echo describe image control lookup_answer audit_pin audit_call repin_pin

  started_api="$(started_at api)"
  started_worker="$(started_at worker)"

  # 1. Both servers attached, no operations: the tools are listed for review, none is offered (CONN-1).
  write_mcp
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  tools="$(cli mcp tools everything 2>&1)" || { fail mcp-attach "mcp tools everything → exit $?: $(tr '\n' '|' <<<"$tools")"; return 0; }
  list="$(user_client bob --list)"
  echo_pin="$(hash_of "$tools" echo)"
  image_pin="$(hash_of "$tools" get-tiny-image)"
  if [[ "$apply_code" == 0 ]] && grep -Eq '^echo sha256:[0-9a-f]{64} - unreferenced$' <<<"$tools" &&
    grep -Eq '^get-tiny-image sha256:[0-9a-f]{64} - unreferenced$' <<<"$tools" &&
    [[ "$(json "$list" '.tools.filter((n)=>n.startsWith("everything.")).length')" == 0 ]]; then
    pass mcp-attach "config apply → exit 0; mcp tools everything: $(grep -E '^(echo|get-tiny-image) ' <<<"$tools" | tr '\n' '|')$(tail -1 <<<"$tools"); bob lists no everything.* tool"
  else
    fail mcp-attach "apply exit $apply_code: $(tr '\n' '|' <<<"$apply"); mcp tools: $(tr '\n' '|' <<<"$tools" | head -c 1500); bob: ${list:0:600}"
    return 0
  fi

  # 2. Three operations bound with the reviewed pins and granted; bob is offered echo, alice is not.
  fake_tools="$(cli mcp tools fakemcp 2>&1 || true)"
  lookup_pin="$(hash_of "$fake_tools" lookup)"
  [[ -n "$lookup_pin" ]] || { fail mcp-enable-grants "no lookup hash in mcp tools fakemcp: $(tr '\n' '|' <<<"$fake_tools")"; return 0; }
  write_mcp "$echo_pin" "$image_pin" "$lookup_pin"
  write_roles "$GRANTS_SUPPORT" "$GRANTS_CONTENT"
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  stamp_1="accept9-$(date -u +%Y%m%dT%H%M%SZ)"
  if [[ "$apply_code" == 0 ]] && await_listed bob everything.echo yes; then
    echo_answer="$(user_mcp bob everything.echo "{\"message\":\"$stamp_1\"}")"
    alice_echo="$(user_mcp alice everything.echo "{\"message\":\"$stamp_1\"}")"
    if [[ "$(lists alice everything.echo)" == no && "$(json "$echo_answer" '.structuredContent.value.text[0]')" == "Echo: $stamp_1" &&
      "$alice_echo" == *"Tool everything.echo not found"* ]]; then
      pass mcp-enable-grants "config apply → exit 0; bob lists everything.echo, alice does not; bob's call → $(json "$echo_answer" '.structuredContent.value'); alice's call → ${alice_echo:0:200}"
    else
      fail mcp-enable-grants "alice lists echo: $(lists alice everything.echo); bob: ${echo_answer:0:800}; alice: ${alice_echo:0:400}"
      return 0
    fi
  else
    fail mcp-enable-grants "apply exit $apply_code: $(tr '\n' '|' <<<"$apply"); bob lists everything.echo: $(lists bob everything.echo)"
    return 0
  fi

  # 3. bob sees the configured description only: no upstream description, metadata or output schema (SEC-6).
  describe="$(user_client bob --describe everything.echo)"
  if [[ "$(json "$describe" '.tool.description')" == "Echo a message back." && "$describe" != *"Echoes back the input string"* &&
    "$describe" != *"Message to echo"* && "$(json "$describe" '.tool._meta')" == "" && "$(json "$describe" '.tool.outputSchema')" == "" ]]; then
    pass mcp-sec6 "bob's listed definition: $(json "$describe" '.tool')"
  else
    fail mcp-sec6 "${describe:0:1200}"
  fi

  # 4. alice's image call: the image is omitted, never relayed as content or base64 (SEC-5).
  image="$(user_mcp alice everything.tiny_image '{}')"
  if [[ "$(json "$image" '.structuredContent.value.omitted >= 1')" == true && "$(json "$image" '.contentTypes.includes("image")')" == false &&
    "$image" != *"data:image"* ]] && ! grep -Eq '[A-Za-z0-9+/=]{201,}' <<<"$image"; then
    pass mcp-sec5 "alice everything.tiny_image → content types $(json "$image" '.contentTypes'); structuredContent $(json "$image" '.structuredContent' | head -c 400)"
  else
    fail mcp-sec5 "${image:0:1200}"
  fi

  # 5. The fake's lookup changes; the next check withdraws the operation and the call is refused (CONN-4).
  control="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"description":"Changed at run time."}' "$FAKE/_control/tools/lookup" || true)"
  [[ "$control" == 204 ]] || { fail mcp-pin-changed "control route → $control"; return 0; }
  if await_listed alice fakemcp.lookup no; then
    lookup_answer="$(user_mcp alice fakemcp.lookup '{"key":"k1"}')"
    audit_pin="$(psql_q "select count(*) from audit_event where action = 'upstream.pin' and subject = 'fakemcp.lookup' and details->>'to' = 'changed'" 2>&1 || true)"
    audit_call="$(psql_q "select count(*) from audit_event where action = 'tool.call' and details->>'errorCode' = 'upstream_changed'" 2>&1 || true)"
    if [[ "$(json "$lookup_answer" '.isError')" == true &&
      "$(json "$lookup_answer" '.text')" == "fakemcp.lookup cannot run: its upstream tool changed since it was reviewed; an operator must review it and record the new pin." &&
      "$audit_pin" == 1 && "$audit_call" == 1 ]]; then
      pass mcp-pin-changed "control → 204; alice no longer lists fakemcp.lookup; her call → $(json "$lookup_answer" '.text'); upstream.pin to changed: $audit_pin; tool.call upstream_changed: $audit_call"
    else
      fail mcp-pin-changed "call: ${lookup_answer:0:800}; upstream.pin to changed: $audit_pin; tool.call upstream_changed: $audit_call"
      return 0
    fi
  else
    fail mcp-pin-changed "alice still lists fakemcp.lookup after 60 s"
    return 0
  fi

  # 6. The operator reviews the change and records the new pin; the operation is offered again, live.
  fake_tools="$(cli mcp tools fakemcp 2>&1 || true)"
  new_pin="$(sed -n 's/^lookup \(sha256:[0-9a-f]\{64\}\) fakemcp\.lookup changed$/\1/p' <<<"$fake_tools")"
  [[ -n "$new_pin" && "$new_pin" != "$lookup_pin" ]] || { fail mcp-repin "mcp tools fakemcp: $(tr '\n' '|' <<<"$fake_tools")"; return 0; }
  write_mcp "$echo_pin" "$image_pin" "$new_pin"
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  if [[ "$apply_code" == 0 ]] && await_listed alice fakemcp.lookup yes; then
    lookup_answer="$(user_mcp alice fakemcp.lookup '{"key":"k1"}')"
    repin_pin="$(psql_q "select count(*) from audit_event where action = 'upstream.pin' and subject = 'fakemcp.lookup' and details->>'from' = 'changed' and details->>'to' = 'ok'" 2>&1 || true)"
    if [[ "$(json "$lookup_answer" '.isError')" == false && -n "$(json "$lookup_answer" '.structuredContent')" && "$repin_pin" -ge 1 &&
      "$(started_at api)" == "$started_api" && "$(started_at worker)" == "$started_worker" ]]; then
      pass mcp-repin "mcp tools fakemcp: lookup $new_pin fakemcp.lookup changed; apply → exit 0; alice's call → $(json "$lookup_answer" '.structuredContent' | head -c 300); upstream.pin changed→ok: $repin_pin; api started $started_api and worker started $started_worker unchanged"
    else
      fail mcp-repin "call: ${lookup_answer:0:800}; upstream.pin changed→ok: $repin_pin; api $started_api → $(started_at api); worker $started_worker → $(started_at worker)"
    fi
  else
    fail mcp-repin "apply exit $apply_code: $(tr '\n' '|' <<<"$apply"); alice lists fakemcp.lookup: $(lists alice fakemcp.lookup)"
  fi
}

# Not GROUPS: bash ignores assignments to its own GROUPS array (the user's group IDs).
RUN_GROUPS="${AIOPS_ACCEPT9_GROUPS:-1}"
for g in $RUN_GROUPS; do
  if declare -F "group_$g" >/dev/null; then
    "group_$g"
  else
    fail "group-$g-missing" "not implemented yet"
  fi
done

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
