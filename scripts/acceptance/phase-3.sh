#!/usr/bin/env bash
# Phase 3 acceptance (SPEC section 7, design part 1 §7) against the Magento sandbox:
#   1. stack-healthy, sandbox-ready
#   2. credential-entered      carol (admins) logs in to the trusted page through the real
#                              Keycloak login and stores the Magento token (UI-5, SEC-8)
#   3. connection-test         the page's connection test reports ok and the scope report (CONN-7)
#   4. search-allowed-brand    alice (content) searches brand acme through MCP: only acme
#                              items, the seeded count, no cost (MCP-4, POL-2, POL-3)
#   5. search-other-brand-denied  brand initech is denied and audited with the rule (POL-2, AUD-1);
#      denied-field-refused: asking for `cost`, which the upstream holds, is denied (POL-3)
#   6. credential-absent-from-logs   token, its Base64 and `Bearer <token>` in no service log (SEC-3)
#   7. credential-absent-from-audit  ... in no audit_event row, nor in plaintext in `credential` (SEC-2)
#   8. page-denied-without-permission (SEC-1), injection-kept-as-data (SEC-5);
#      stale-session-refused (SEC-8) needs time control and is covered by the api e2e tests
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that
# joins the api to the sandbox network and mounts a generated configuration (the development
# configuration with the sandbox URL). Prints one PASS/FAIL line per check; exits non-zero if
# any check fails. Not part of CI (.github/workflows/ci.yml): it needs the Magento sandbox
# of deploy/sandbox/magento, which takes a long first install and several GB.
# Secrets: the Magento token travels through variables, stdin and here-strings only; it is
# never echoed, never on a command line, and only counts of matches are printed.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept3-$$"
FAILED=0
SANDBOX="http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
export AIOPS_MAILPIT_PORT="$(free_port)"  # Compose runs Mailpit since Phase 6; a fixed port breaks parallel runs
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
# Origin of the trusted pages and the realm's redirect URI of the aiops-web client.
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-3.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password /app/credentials; }
page_api() { AIOPS_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
mcp() { node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" "$@"; }
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }
# Counts rows of a table whose JSON form contains the value on stdin's first line: the value
# reaches psql as a variable on stdin, never on a command line.
psql_contains() {
  local value
  IFS= read -r value
  printf "\\\\set v '%s'\nselect count(*) from %s t where row_to_json(t)::text like '%%' || :'v' || '%%';\n" "$value" "$1" |
    compose exec -T postgres psql -U aiops -d aiops -tA -q
}

echo "# Phase 3 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"

# 1b. The sandbox is up (idempotent) and seeded (idempotent); its token is the credential.
if bash "$REPO/deploy/sandbox/magento/up.sh" >"$WORK/sandbox.log" 2>&1 &&
  node "$REPO/deploy/sandbox/magento/seed.mjs" "$SANDBOX" >>"$WORK/sandbox.log" 2>&1 &&
  TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>>"$WORK/sandbox.log")" && [[ -n "$TOKEN" ]]; then
  # The seeded acme products, counted at the sandbox itself (not through the platform).
  ACME_COUNT="$(MAGENTO_TOKEN="$TOKEN" node -e "
    const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'acme', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '1' });
    fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
      .then((r) => r.json()).then((b) => console.log(b.total_count ?? ''), () => console.log(''));" "$SANDBOX")"
  if [[ "$ACME_COUNT" =~ ^[1-9][0-9]*$ ]] && docker network inspect aiops-sandbox >/dev/null 2>&1; then
    pass sandbox-ready "$(grep -o 'SANDBOX UP.*' "$WORK/sandbox.log" | tail -1); seeded acme products: $ACME_COUNT; network aiops-sandbox present"
  else
    fail sandbox-ready "acme count '$ACME_COUNT'"; exit 1
  fi
else
  fail sandbox-ready "see sandbox output below"; tail -30 "$WORK/sandbox.log"; exit 1
fi
TOKEN_B64="$(printf '%s' "$TOKEN" | base64 -w0)"
BEARER="Bearer $TOKEN"

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# The acceptance configuration: the development configuration with the sandbox URL.
mkdir -p "$AIOPS_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$AIOPS_ACCEPT_CONFIG_DIR/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }

# 1a. One command from a fresh clone.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  pass stack-healthy "docker compose up -d --build --wait (api on networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(compose ps -q api)" | xargs))"
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api | tail -30; exit 1
fi

# 2. carol enters the credential on the trusted page.
CAROL="$(page_login carol 2>&1)" || { fail page-login-carol "$CAROL"; CAROL=""; }
SESSION="$(page_api "$CAROL" session 2>&1 || true)"
PUT="$(page_api "$CAROL" put-credential magento-integration <<<"$TOKEN" 2>&1 || true)"
STORED="$(psql_q "select count(*) from credential where ref = 'magento-integration'" 2>&1 || true)"
if [[ "$(json "$PUT" '.status')" == 204 && "$STORED" == 1 ]]; then
  pass credential-entered "carol roles $(json "$SESSION" '.body.roles'), PUT /api/v1/credentials/magento-integration → 204; credential rows: $STORED"
else
  fail credential-entered "session=$SESSION put=$PUT stored=$STORED"
fi

# 3. The page's connection test.
TEST="$(page_api "$CAROL" test magento 2>&1 || true)"
if [[ "$(json "$TEST" '.status')" == 200 && "$(json "$TEST" '.body.ok')" == true && -n "$(json "$TEST" '.body.scopes.source')" ]]; then
  pass connection-test "$(json "$TEST" '.body')"
else
  fail connection-test "$TEST"
fi

# 4. alice searches her own brand through the MCP endpoint.
ALICE="$(login alice 2>&1)" || { fail login-alice "$ALICE"; ALICE=""; }
SEARCH="$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"acme","fields":["sku","name","brand","price"]}' 2>&1 || true)"
CHECK="$(node -e '
  const r = JSON.parse(process.argv[1]); const s = r.structuredContent ?? {}; const items = s.items ?? [];
  const problems = [];
  if (r.isError) problems.push("isError");
  if (items.length !== Number(process.argv[2])) problems.push(`items ${items.length}`);
  if (s.total !== Number(process.argv[2])) problems.push(`total ${s.total}`);
  if (!items.every((i) => i.brand === "acme")) problems.push("a non-acme item");
  if (items.some((i) => "cost" in i) || JSON.stringify(r).includes("\"cost\"")) problems.push("cost present");
  console.log(problems.length === 0 ? `ok ${items.map((i) => i.sku).join(",")}` : problems.join("; "));' "$SEARCH" "$ACME_COUNT" 2>&1 || true)"
if [[ "$CHECK" == ok* ]]; then
  pass search-allowed-brand "${CHECK#ok } (total ${ACME_COUNT} = seeded acme count, every brand acme, no cost); summary: $(json "$SEARCH" '.content[0]')"
else
  fail search-allowed-brand "$CHECK: $SEARCH"
fi

# 5. Another brand is denied by policy, and the denial is audited with its rule.
DENY="$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"initech","fields":["sku","name"]}' 2>&1 || true)"
DENY_CID="$(json "$DENY" '.correlationId')"
ROW="$(psql_q "select actor || ' ' || decision || ' ' || (details->>'rule') from audit_event where correlation_id = '${DENY_CID}' and action = 'policy.decision'" 2>&1 || true)"
if [[ "$(json "$DENY" '.isError')" == true && "$(json "$DENY" '.text')" == "Denied by policy:"* && -n "$DENY_CID" &&
  "$ROW" == *" deny role:content_manager/grant:own-brands/scope:brand" ]]; then
  pass search-other-brand-denied "$(json "$DENY" '.text') | audited correlation_id=$DENY_CID: $ROW"
else
  fail search-other-brand-denied "result=$DENY row=$ROW"
fi

# 5b. A denied field is refused before any upstream call, although the upstream holds it
# (POL-3): the raw sandbox product carries `cost`, the same search asking for it is denied.
RAW_COST="$(TOKEN="$TOKEN" node -e '
  fetch(process.argv[1] + "/rest/all/V1/products?searchCriteria[filter_groups][0][filters][0][field]=brand&searchCriteria[filter_groups][0][filters][0][value]=acme&searchCriteria[pageSize]=1",
    { headers: { authorization: "Bearer " + process.env.TOKEN, accept: "application/json" } })
    .then((r) => r.json()).then((b) => console.log((b.items?.[0]?.custom_attributes ?? []).some((a) => a.attribute_code === "cost") ? "has-cost" : "no-cost"), () => console.log("error"));' "$SANDBOX" 2>&1 || true)"
COST="$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"acme","fields":["sku","cost"]}' 2>&1 || true)"
COST_CID="$(json "$COST" '.correlationId')"
COST_ROW="$(psql_q "select decision || ' ' || (details->>'rule') from audit_event where correlation_id = '${COST_CID}' and action = 'policy.decision'" 2>&1 || true)"
COST_CALLS="$(psql_q "select count(*) from audit_event where correlation_id = '${COST_CID}' and action = 'tool.call'" 2>&1 || true)"
if [[ "$RAW_COST" == has-cost && "$(json "$COST" '.isError')" == true && "$(json "$COST" '.text')" == "Denied by policy:"* &&
  "$COST_ROW" == "deny role:content_manager/grant:own-brands/deny_fields" && "$COST_CALLS" == 0 ]]; then
  pass denied-field-refused "upstream product has cost: yes; $(json "$COST" '.text') | audited: $COST_ROW; tool.call rows: 0"
else
  fail denied-field-refused "raw=$RAW_COST result=$COST row=$COST_ROW calls=$COST_CALLS"
fi

# 8a. Upstream content stays data: the instruction-like description of ACME-003 appears only
# in the JSON part and structuredContent, never in the summary (SEC-5).
INJ="$(mcp --token "$ALICE" --tool catalog.search_products --args '{"brand":"acme","fields":["sku","description"]}' 2>&1 || true)"
INJ_CHECK="$(node -e '
  const r = JSON.parse(process.argv[1]); const needle = "Ignore previous instructions";
  const [summary = "", data = ""] = r.content ?? [];
  const inStructured = JSON.stringify(r.structuredContent ?? {}).includes(needle);
  console.log(!summary.includes(needle) && data.includes(needle) && inStructured && (r.content ?? []).length === 2 ? "ok" : `summary=${summary.includes(needle)} json=${data.includes(needle)} structured=${inStructured} parts=${(r.content ?? []).length}`);' "$INJ" 2>&1 || true)"
if [[ "$INJ_CHECK" == ok ]]; then
  pass injection-kept-as-data "instruction-like text only in content[1] (JSON) and structuredContent; content[0]: $(json "$INJ" '.content[0]')"
else
  fail injection-kept-as-data "$INJ_CHECK"
fi

# 8b. bob (support) may not store a credential (SEC-1).
BOB="$(page_login bob 2>&1)" || { fail page-login-bob "$BOB"; BOB=""; }
BOB_PUT="$(page_api "$BOB" put-credential magento-integration <<<"not-a-real-token" 2>&1 || true)"
if [[ "$(json "$BOB_PUT" '.status')" == 403 ]]; then
  pass page-denied-without-permission "bob PUT /api/v1/credentials/magento-integration → $BOB_PUT"
else
  fail page-denied-without-permission "$BOB_PUT"
fi

# 6. The credential occurs in no service log (SEC-3). Values reach grep through a pattern file
# from a here-string, never on a command line; only counts are printed.
compose logs --no-color >"$WORK/all.log" 2>&1 || true
LOG_LINES="$(wc -l <"$WORK/all.log")"
count_in() { grep -F -c -f /dev/stdin "$1" || true; }
L_TOKEN="$(count_in "$WORK/all.log" <<<"$TOKEN")"
L_B64="$(count_in "$WORK/all.log" <<<"$TOKEN_B64")"
L_BEARER="$(count_in "$WORK/all.log" <<<"$BEARER")"
# Control: the same search finds a value that is in the logs.
L_CONTROL="$(count_in "$WORK/all.log" <<<"keycloak bootstrap done")"
# The api's own stream is captured too: its start line and its per-call upstream lines.
L_API="$(count_in "$WORK/all.log" <<<"api listening")"
L_UPSTREAM="$(count_in "$WORK/all.log" <<<"upstream call completed")"
if [[ "$LOG_LINES" -gt 0 && "$L_CONTROL" -gt 0 && "$L_API" -gt 0 && "$L_UPSTREAM" -gt 0 && "$L_TOKEN" == 0 && "$L_B64" == 0 && "$L_BEARER" == 0 ]]; then
  pass credential-absent-from-logs "$LOG_LINES log lines of all services: token 0, Base64 0, 'Bearer <token>' 0 (controls 'keycloak bootstrap done': $L_CONTROL, 'api listening': $L_API, 'upstream call completed': $L_UPSTREAM)"
else
  fail credential-absent-from-logs "lines=$LOG_LINES control=$L_CONTROL api=$L_API upstream=$L_UPSTREAM token=$L_TOKEN base64=$L_B64 bearer=$L_BEARER"
fi

# 7. ... nor in any audit row, nor in plaintext in the credential table (SEC-2, SEC-3).
AUDIT_ROWS="$(psql_q "select count(*) from audit_event" 2>&1 || true)"
A_TOKEN="$(psql_contains audit_event <<<"$TOKEN" 2>&1 || true)"
A_B64="$(psql_contains audit_event <<<"$TOKEN_B64" 2>&1 || true)"
A_BEARER="$(psql_contains audit_event <<<"$BEARER" 2>&1 || true)"
C_TOKEN="$(psql_contains credential <<<"$TOKEN" 2>&1 || true)"
C_B64="$(psql_contains credential <<<"$TOKEN_B64" 2>&1 || true)"
# Controls: the same search finds values that are there.
A_CONTROL="$(psql_contains audit_event <<<"credential.set" 2>&1 || true)"
C_CONTROL="$(psql_contains credential <<<"magento-integration" 2>&1 || true)"
if [[ "$AUDIT_ROWS" =~ ^[1-9][0-9]*$ && "$A_CONTROL" =~ ^[1-9][0-9]*$ && "$C_CONTROL" == 1 && "$A_TOKEN" == 0 && "$A_B64" == 0 && "$A_BEARER" == 0 && "$C_TOKEN" == 0 && "$C_B64" == 0 && "$STORED" == 1 ]]; then
  pass credential-absent-from-audit "$AUDIT_ROWS audit_event rows: token 0, Base64 0, 'Bearer <token>' 0; credential table (1 row): plaintext 0, Base64 0 (controls 'credential.set': $A_CONTROL, 'magento-integration': $C_CONTROL)"
else
  fail credential-absent-from-audit "rows=$AUDIT_ROWS controls=$A_CONTROL/$C_CONTROL audit token=$A_TOKEN base64=$A_B64 bearer=$A_BEARER; credential token=$C_TOKEN base64=$C_B64"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
