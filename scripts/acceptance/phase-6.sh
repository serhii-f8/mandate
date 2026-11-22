#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Phase 6 acceptance (SPEC section 7, designs phase-6-approvals*) against the Magento sandbox:
#   sandbox-ready, stack-healthy (one worker, Mailpit), credential-entered, below-threshold-executes,
#   above-threshold-pending, cannot-execute-without-approval, requester-cannot-approve,
#   stale-hash-refused, approver-approves-executes, tampered-hash-check,
#   approval-after-expiry-refused, notification-email, credential-absent (SEC-3).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that joins
# the api and the worker to the sandbox network and mounts a generated configuration.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: needs the sandbox. A run takes about 10-15 minutes.
# Secrets: the Magento token travels through variables, stdin and the environment of node only.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="mandate-accept6-$$"
FAILED=0
SANDBOX="http://127.0.0.1:${MANDATE_MAGENTO_PORT:-4390}"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export MANDATE_API_PORT="$(free_port)" MANDATE_KEYCLOAK_PORT="$(free_port)" MANDATE_TEMPORAL_PORT="$(free_port)" MANDATE_POSTGRES_PORT="$(free_port)"
export MANDATE_MAILPIT_PORT="$(free_port)"
export MANDATE_KEYCLOAK_PUBLIC_URL="http://localhost:${MANDATE_KEYCLOAK_PORT}"
export MANDATE_MCP_RESOURCE="http://localhost:${MANDATE_API_PORT}/mcp"
# Origin of the trusted pages, the realm's redirect URI of the mandate-web client and the base of
# the links in notification e-mails.
export MANDATE_PUBLIC_URL="http://localhost:${MANDATE_API_PORT}"
export MANDATE_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${MANDATE_API_PORT}/mcp"
API="$MANDATE_PUBLIC_URL"
MAILPIT="http://127.0.0.1:${MANDATE_MAILPIT_PORT}"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-6.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/mandate" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(v===undefined?'':typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$MANDATE_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$MANDATE_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password "${2:-/app/approvals}"; }
page_api() { MANDATE_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
# alice calls a tool; she logs in again before every call, so no token expires during the run.
alice_mcp() {
  local token
  token="$(login alice 2>&1)" || { echo "{\"loginError\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$token")}"; return 0; }
  node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --token "$token" --tool "$1" --args "$2" 2>&1 || true
}
psql_q() { compose exec -T postgres psql -U mandate -d mandate -tAc "$1"; }
# The superuser, for session_replication_role (the image trusts local socket connections).
psql_su() { compose exec -T postgres psql -U postgres -d mandate -v ON_ERROR_STOP=1 -tAc "$1"; }
# Counts rows of a table whose JSON form contains the value on stdin's first line: the value
# reaches psql as a variable on stdin, never on a command line.
psql_contains() {
  local value
  IFS= read -r value
  printf "\\\\set v '%s'\nselect count(*) from %s t where row_to_json(t)::text like '%%' || :'v' || '%%';\n" "$value" "$1" |
    compose exec -T postgres psql -U mandate -d mandate -tA -q
}
# get_changeset every 2 s until the status matches the regex or the timeout (s) passes; the last
# answer is left in POLL and its status in POLL_STATUS. Returns 1 on timeout.
poll_cs() {
  local id="$1" until="$2" deadline=$((SECONDS + $3))
  while :; do
    POLL="$(alice_mcp get_changeset "{\"changeset_id\":\"$id\",\"page_size\":${4:-1}}")"
    POLL_STATUS="$(json "$POLL" '.structuredContent.changeset.status')"
    [[ "$POLL_STATUS" =~ $until ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}
TERMINAL='^(completed|completed_with_errors|failed|cancelled|expired|rolled_back)$'
running_workers() { compose ps worker --status running -q | wc -l | tr -d ' '; }
stamp() { echo "Phase 6 $1 $(date -u +%Y%m%dT%H%M%SZ)"; }
# update_content arguments for comma-separated SKUs and a description.
cs_args() { node -e 'console.log(JSON.stringify({ brand: "umbrella", skus: process.argv[1].split(","), changes: { description: process.argv[2] } }))' "$1" "$2"; }
submit() { alice_mcp submit_for_approval "{\"changeset_id\":\"$1\",\"hash\":\"$2\"}"; }
# yes when no SKU of the descriptions JSON carries the value.
none_has() { node -e 'try{const o=JSON.parse(process.argv[1]);console.log(Object.keys(o).length>0&&Object.values(o).every((d)=>!String(d??"").includes(process.argv[2]))?"yes":"no")}catch{console.log("no")}' "$1" "$2"; }
# yes when every SKU in the list has exactly the value.
all_have() { node -e 'try{const o=JSON.parse(process.argv[1]);console.log(process.argv[2].split(",").every((s)=>o[s]===process.argv[3])?"yes":"no")}catch{console.log("no")}' "$1" "$2" "$3"; }

echo "# Phase 6 acceptance of ${SHA:0:12} (project $PROJECT, api port $MANDATE_API_PORT, mailpit port $MANDATE_MAILPIT_PORT)"

# 1. The sandbox is up (idempotent) and seeded (idempotent); its token is the credential.
if bash "$REPO/deploy/sandbox/magento/up.sh" >"$WORK/sandbox.log" 2>&1 &&
  node "$REPO/deploy/sandbox/magento/seed.mjs" "$SANDBOX" >>"$WORK/sandbox.log" 2>&1 &&
  TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>>"$WORK/sandbox.log")" && [[ -n "$TOKEN" ]]; then
  if docker network inspect mandate-sandbox >/dev/null 2>&1; then
    pass sandbox-ready "$(grep -o 'SANDBOX UP.*' "$WORK/sandbox.log" | tail -1); $(grep -o 'SEEDED umbrella.*' "$WORK/sandbox.log" | tail -1); token present; network mandate-sandbox present"
  else
    fail sandbox-ready "network mandate-sandbox missing"; exit 1
  fi
else
  fail sandbox-ready "see sandbox output below"; tail -30 "$WORK/sandbox.log"; exit 1
fi

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/mandate"
git -C "$WORK/mandate" checkout --quiet --detach "$SHA"
cd "$WORK/mandate"

# The acceptance configuration: the development configuration with the sandbox URL, and roles
# with a record threshold of 2, a notified approver role and a short expiry.
mkdir -p "$MANDATE_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$MANDATE_ACCEPT_CONFIG_DIR/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }
if grep -lE '^(changesets|notifications):' "$MANDATE_ACCEPT_CONFIG_DIR"/*.yaml >/dev/null; then
  fail acceptance-config "the development configuration already has changesets: or notifications: ($(grep -lE '^(changesets|notifications):' "$MANDATE_ACCEPT_CONFIG_DIR"/*.yaml | xargs -n1 basename | xargs))"; exit 1
fi
cat >"$MANDATE_ACCEPT_CONFIG_DIR/roles.yaml" <<'YAML'
version: 1
notifications:
  - { id: content-leads-mail, kind: email, to: [content-leads@example.test] }
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, id: own-brands, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
      - { operation: catalog.update_content, id: own-brands-content, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
    approval: { required: above_threshold, record_threshold: 2, steps: [{ role: content_lead }] }
  - id: content_lead
    grants: []
    notify: { approval_requests: [content-leads-mail] }
  - { id: support_agent, grants: [{ operation: support.lookup_order }] }
  - { id: integration_admin, grants: [], manage_credentials: [magento-integration] }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: content-leads, roles: [content_lead] }
  - { group: support, roles: [support_agent] }
  - { group: admins, roles: [integration_admin] }
changesets:
  expire_after_hours: 0.05
YAML

# 2. One command from a fresh clone; one worker; Mailpit catches the e-mail.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  WORKERS="$(running_workers)"
  MAILPIT_UP="$(compose ps mailpit --status running -q | wc -l | tr -d ' ')"
  if [[ "$WORKERS" == 1 && "$MAILPIT_UP" == 1 ]] && curl -sf "$MAILPIT/api/v1/messages" >/dev/null; then
    pass stack-healthy "docker compose up -d --build --wait; running workers: $WORKERS; mailpit running: $MAILPIT_UP; GET $MAILPIT/api/v1/messages ok"
  else
    fail stack-healthy "running workers: $WORKERS; mailpit running: $MAILPIT_UP"; compose ps -a; exit 1
  fi
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api worker | tail -30; exit 1
fi

# 3. carol enters the credential on the trusted page.
CAROL="$(page_login carol /app/credentials 2>&1)" || { fail credential-entered "page login: $CAROL"; exit 1; }
PUT="$(page_api "$CAROL" put-credential magento-integration <<<"$TOKEN" 2>&1 || true)"
if [[ "$(json "$PUT" '.status')" == 204 ]]; then
  pass credential-entered "carol: page login and put-credential magento-integration → 204"
else
  fail credential-entered "$PUT"; exit 1
fi

# Reads the description of some SKUs at the sandbox as {sku: description}.
sandbox_descriptions() {
  MAGENTO_TOKEN="$TOKEN" node -e "
    const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'sku', 'searchCriteria[filter_groups][0][filters][0][value]': process.argv[2], 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in', 'searchCriteria[pageSize]': '50' });
    fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
      .then((r) => r.json()).then((b) => { const o = {}; for (const i of b.items ?? []) o[i.sku] = (i.custom_attributes ?? []).find((a) => a.attribute_code === 'description')?.value ?? null; console.log(JSON.stringify(o)); }, () => console.log('{}'));" "$SANDBOX" "$1"
}
# Prepares update_content; leaves the change-set ID in PREP_ID and the last answer in PREP. The
# answer is prepared, or preparing (bounded wait, MCP-1), then polled until it leaves preparing.
prepare() {
  PREP="$(alice_mcp catalog.update_content "$1")"
  PREP_ID="$(json "$PREP" '.structuredContent.changeset.id')"
  [[ -n "$PREP_ID" ]] || PREP_ID="$(json "$PREP" '.structuredContent.changesetId')"
  local status
  status="$(json "$PREP" '.structuredContent.changeset.status')"
  [[ -n "$status" ]] || status="$(json "$PREP" '.structuredContent.status')"
  PREP_FIRST="$status"
  if [[ "$status" == preparing && -n "$PREP_ID" ]]; then
    poll_cs "$PREP_ID" '^[^p]|^prepared$' "$2" || true
    PREP="$POLL"
  fi
  PREP_HASH="$(json "$PREP" '.structuredContent.changeset.hash')"
  PREP_STATUS="$(json "$PREP" '.structuredContent.changeset.status')"
}

# 4. Two records, at the threshold: executes without approval.
SKUS_B="UMBRELLA-0201,UMBRELLA-0202"
STAMP_B="$(stamp below-threshold-executes)"
prepare "$(cs_args "$SKUS_B" "$STAMP_B")" 120
CS_B="$PREP_ID"
SUB_B="$(submit "$CS_B" "$PREP_HASH")"
SUB_B_STATUS="$(json "$SUB_B" '.structuredContent.status')"
SUB_B_APPROVAL="$(json "$SUB_B" '.structuredContent.approval')"
poll_cs "$CS_B" "$TERMINAL" 300 || true
DESC_B="$(sandbox_descriptions "$SKUS_B")"
APPROVALS_B="$(psql_q "select count(*) from approval where changeset_id = '$CS_B'" 2>&1 || true)"
if [[ "$PREP_STATUS" == prepared && "$SUB_B_STATUS" == executing && -z "$SUB_B_APPROVAL" && "$POLL_STATUS" == completed &&
  "$(all_have "$DESC_B" "$SKUS_B" "$STAMP_B")" == yes && "$APPROVALS_B" == 0 ]]; then
  pass below-threshold-executes "change-set $CS_B (2 records, threshold 2): submit → executing, no approval in the answer; then $POLL_STATUS; sandbox $DESC_B; approval rows: $APPROVALS_B"
else
  fail below-threshold-executes "prepared=$PREP_STATUS submit=${SUB_B:0:800} status=$POLL_STATUS sandbox=$DESC_B approvals=$APPROVALS_B"
fi

# 5. Setup: a change-set that expires while pending (expire_after_hours 0.05 = 180 s).
SKUS_E="UMBRELLA-0231,UMBRELLA-0232,UMBRELLA-0233"
STAMP_E="$(stamp approval-after-expiry-refused)"
prepare "$(cs_args "$SKUS_E" "$STAMP_E")" 120
CS_E="$PREP_ID"
HASH_E="$PREP_HASH"
SUB_E="$(submit "$CS_E" "$HASH_E")"
SUB_E_STATUS="$(json "$SUB_E" '.structuredContent.status')"
EXPIRES_AT="$(psql_q "select extract(epoch from expires_at)::bigint from change_set where id = '$CS_E'" 2>&1 || true)"
echo "# setup: change-set $CS_E submitted → $SUB_E_STATUS; expires_at epoch $EXPIRES_AT (now $(date +%s))"

# 6. Three records, above the threshold: pending approval at step 1.
SKUS_A="UMBRELLA-0211,UMBRELLA-0212,UMBRELLA-0213"
STAMP_A="$(stamp above-threshold-pending)"
prepare "$(cs_args "$SKUS_A" "$STAMP_A")" 120
CS_A="$PREP_ID"
HASH_A_PREP="$PREP_HASH"
SUB_A="$(submit "$CS_A" "$HASH_A_PREP")"
SUB_A_TEXT="$(json "$SUB_A" '.text')"
if [[ "$(json "$SUB_A" '.structuredContent.status')" == pending_approval && "$(json "$SUB_A" '.structuredContent.approval.step')" == 1 &&
  "$SUB_A_TEXT" == *"/app/changesets/$CS_A"* && "$(json "$SUB_A" '.isError')" != true ]]; then
  pass above-threshold-pending "change-set $CS_A (3 records): submit → $(json "$SUB_A" '.structuredContent') — $SUB_A_TEXT"
else
  fail above-threshold-pending "prepared=$PREP_STATUS submit=${SUB_A:0:1200}"
fi

# 7. Nothing runs without approval; a second submission is refused.
sleep 20
G_A="$(alice_mcp get_changeset "{\"changeset_id\":\"$CS_A\",\"page_size\":1}")"
G_A_STATUS="$(json "$G_A" '.structuredContent.changeset.status')"
DESC_A0="$(sandbox_descriptions "$SKUS_A")"
SUB_A2="$(submit "$CS_A" "$HASH_A_PREP")"
G_A2="$(alice_mcp get_changeset "{\"changeset_id\":\"$CS_A\",\"page_size\":1}")"
G_A2_STATUS="$(json "$G_A2" '.structuredContent.changeset.status')"
NOT_STARTED="$(psql_q "select execution_started_at is null from change_set where id = '$CS_A'" 2>&1 || true)"
if [[ "$G_A_STATUS" == pending_approval && "$(none_has "$DESC_A0" "$STAMP_A")" == yes && "$(json "$SUB_A2" '.isError')" == true &&
  "$G_A2_STATUS" == pending_approval && "$NOT_STARTED" == t ]]; then
  pass cannot-execute-without-approval "after 20 s: status $G_A_STATUS; sandbox without the stamp $DESC_A0; second submit → isError: $(json "$SUB_A2" '.text'); status still $G_A2_STATUS; execution_started_at is null: $NOT_STARTED"
else
  fail cannot-execute-without-approval "status=$G_A_STATUS sandbox=$DESC_A0 second=${SUB_A2:0:800} after=$G_A2_STATUS not_started=$NOT_STARTED"
fi

# 8. The requester cannot approve her own change-set (separation of duties).
ALICE="$(page_login alice 2>&1)" || { fail requester-cannot-approve "page login: $ALICE"; ALICE=""; }
CSV_A="$(page_api "$ALICE" changeset "$CS_A" 2>&1 || true)"
HASH_A="$(json "$CSV_A" '.body.hash')"
COUNT_A="$(json "$CSV_A" '.body.stats.included')"
DEC_ALICE="$(page_api "$ALICE" decide "$CS_A" approve "${HASH_A:-x}" "${COUNT_A:-0}" 2>&1 || true)"
SOD_AUDIT="$(psql_q "select count(*) from audit_event where action = 'approval.decision' and outcome = 'denied' and changeset_id = '$CS_A' and details->>'reason' = 'separation_of_duties'" 2>&1 || true)"
if [[ "$COUNT_A" == 3 && "$(json "$DEC_ALICE" '.status')" == 403 && "$(json "$DEC_ALICE" '.body.error')" == separation_of_duties && "$SOD_AUDIT" == 1 ]]; then
  pass requester-cannot-approve "alice: changeset view hash $HASH_A included $COUNT_A; decide approve → $DEC_ALICE; denied approval.decision audit events (separation_of_duties): $SOD_AUDIT"
else
  fail requester-cannot-approve "view=${CSV_A:0:600} decide=$DEC_ALICE audit=$SOD_AUDIT"
fi

# 9. A decision on a hash other than the change-set's is refused.
DAVE="$(page_login dave 2>&1)" || { fail stale-hash-refused "page login: $DAVE"; DAVE=""; }
ZERO_HASH="sha256:$(printf '0%.0s' {1..64})"
DEC_STALE="$(page_api "$DAVE" decide "$CS_E" approve "$ZERO_HASH" 3 2>&1 || true)"
CSV_E="$(page_api "$DAVE" changeset "$CS_E" 2>&1 || true)"
if [[ "$(json "$DEC_STALE" '.status')" == 409 && "$(json "$DEC_STALE" '.body.error')" == hash_mismatch && "$(json "$CSV_E" '.body.status')" == pending_approval ]]; then
  pass stale-hash-refused "dave: decide $CS_E approve with $ZERO_HASH → $DEC_STALE; change-set still $(json "$CSV_E" '.body.status')"
else
  fail stale-hash-refused "decide=$DEC_STALE view=${CSV_E:0:600}"
fi

# 10. The approver approves after a fresh login; the change-set executes.
SUBMITTED="$(psql_q "select submission->>'at' from change_set where id='$CS_A'" 2>&1 || true)"
DAVE="$(page_login dave 2>&1)" || { fail approver-approves-executes "page login: $DAVE"; DAVE=""; }
QUEUE="$(page_api "$DAVE" approvals 2>&1 || true)"
CSV_A="$(page_api "$DAVE" changeset "$CS_A" 2>&1 || true)"
HASH_A="$(json "$CSV_A" '.body.hash')"
COUNT_A="$(json "$CSV_A" '.body.stats.included')"
DEC_DAVE="$(page_api "$DAVE" decide "$CS_A" approve "${HASH_A:-x}" "${COUNT_A:-0}" 2>&1 || true)"
poll_cs "$CS_A" "$TERMINAL" 300 || true
DESC_A="$(sandbox_descriptions "$SKUS_A")"
OK_AUDIT="$(psql_q "select count(*) from audit_event where action='approval.decision' and outcome='ok' and changeset_id='$CS_A' and details->>'channel'='page'" 2>&1 || true)"
FRESH="$(psql_q "select count(*) from approval a join change_set c on c.id = a.changeset_id where a.changeset_id='$CS_A' and a.decision='approved' and a.channel='page' and a.auth_time >= (c.submission->>'at')::timestamptz" 2>&1 || true)"
AUTH_TIME="$(psql_q "select auth_time from approval where changeset_id='$CS_A' and decision='approved'" 2>&1 || true)"
if [[ "$QUEUE" == *"$CS_A"* && "$(json "$DEC_DAVE" '.status')" == 200 && "$(json "$DEC_DAVE" '.body.status')" =~ ^(approved|executing)$ &&
  "$POLL_STATUS" == completed && "$(all_have "$DESC_A" "$SKUS_A" "$STAMP_A")" == yes && "$OK_AUDIT" == 1 && "$FRESH" == 1 ]]; then
  pass approver-approves-executes "dave: queue lists $CS_A; decide approve $HASH_A $COUNT_A → $DEC_DAVE; then $POLL_STATUS; sandbox $DESC_A; ok approval.decision audit events (page): $OK_AUDIT; submitted at $SUBMITTED, approval auth_time $AUTH_TIME (fresh: $FRESH)"
else
  fail approver-approves-executes "queue=${QUEUE:0:600} decide=$DEC_DAVE status=$POLL_STATUS sandbox=$DESC_A audit=$OK_AUDIT fresh=$FRESH submitted=$SUBMITTED auth_time=$AUTH_TIME"
fi

# 11. An item changed in the database behind the hash: the execution re-checks and refuses.
SKUS_T="UMBRELLA-0221,UMBRELLA-0222,UMBRELLA-0223"
STAMP_T="$(stamp tampered-hash-check)"
prepare "$(cs_args "$SKUS_T" "$STAMP_T")" 120
CS_T="$PREP_ID"
SUB_T="$(submit "$CS_T" "$PREP_HASH")"
CSV_T="$(page_api "$DAVE" changeset "$CS_T" 2>&1 || true)"
HASH_T="$(json "$CSV_T" '.body.hash')"
COUNT_T="$(json "$CSV_T" '.body.stats.included')"
TAMPER="$(psql_su "begin; set local session_replication_role = replica; update change_item set after = after || '{\"description\":\"Tampered\"}'::jsonb where changeset_id = '$CS_T' and target_id = 'UMBRELLA-0221'; commit;" 2>&1 || true)"
DAVE="$(page_login dave 2>&1)" || { fail tampered-hash-check "page login: $DAVE"; DAVE=""; }
DEC_T="$(page_api "$DAVE" decide "$CS_T" approve "${HASH_T:-x}" "${COUNT_T:-0}" 2>&1 || true)"
poll_cs "$CS_T" "$TERMINAL" 300 || true
T_STATE="$(psql_q "select status || '|' || coalesce(error_code,'') from change_set where id='$CS_T'" 2>&1 || true)"
DESC_T="$(sandbox_descriptions "$SKUS_T")"
if [[ "$(json "$SUB_T" '.structuredContent.status')" == pending_approval ]] && grep -qx 'UPDATE 1' <<<"$TAMPER" &&
  [[ "$(json "$DEC_T" '.status')" == 200 && "$T_STATE" == "failed|hash_mismatch" && "$(none_has "$DESC_T" "$STAMP_T")" == yes && "$(none_has "$DESC_T" Tampered)" == yes ]]; then
  pass tampered-hash-check "change-set $CS_T pending; change_item UMBRELLA-0221 updated with triggers off (UPDATE 1); dave approves $HASH_T → $(json "$DEC_T" '.status'); final $T_STATE; sandbox $DESC_T"
else
  fail tampered-hash-check "submit=${SUB_T:0:400} tamper=$(tr '\n' ' ' <<<"$TAMPER") decide=$DEC_T state=$T_STATE sandbox=$DESC_T"
fi

# 12. After expires_at, an approval is refused and the change-set is expired.
if [[ "$EXPIRES_AT" =~ ^[0-9]+$ ]]; then
  T0=$SECONDS
  while (($(date +%s) <= EXPIRES_AT + 5 && SECONDS - T0 < 300)); do sleep 5; done
fi
DAVE="$(page_login dave 2>&1)" || { fail approval-after-expiry-refused "page login: $DAVE"; DAVE=""; }
DEC_E="$(page_api "$DAVE" decide "$CS_E" approve "${HASH_E:-x}" 3 2>&1 || true)"
E_STATUS="$(psql_q "select status from change_set where id='$CS_E'" 2>&1 || true)"
DESC_E="$(sandbox_descriptions "$SKUS_E")"
if [[ "$SUB_E_STATUS" == pending_approval && "$(json "$DEC_E" '.status')" == 409 && "$(json "$DEC_E" '.body.error')" == expired &&
  "$E_STATUS" == expired && "$(none_has "$DESC_E" "$STAMP_E")" == yes ]]; then
  pass approval-after-expiry-refused "change-set $CS_E expires_at epoch $EXPIRES_AT, now $(date +%s); dave decide approve → $DEC_E; status $E_STATUS; sandbox $DESC_E"
else
  fail approval-after-expiry-refused "submitted=$SUB_E_STATUS expires_at=$EXPIRES_AT now=$(date +%s) decide=$DEC_E status=$E_STATUS sandbox=$DESC_E"
fi

# 13. The approver role got an e-mail with the link and no change content (NTF-1, NTF-2).
# Mailpit's search tokenizes UUIDs (ADR 0034 n): list the messages and fetch each one instead.
MAIL='{}'
T0=$SECONDS
while ((SECONDS - T0 < 60)); do
  MAIL="$(STAMP_A="$STAMP_A" node -e '
    const [base, cs, pub] = process.argv.slice(1);
    (async () => {
      const list = await (await fetch(base + "/api/v1/messages?limit=200")).json();
      for (const m of list.messages ?? []) {
        const msg = await (await fetch(base + "/api/v1/message/" + encodeURIComponent(m.ID))).json();
        const text = String(msg.Text ?? "");
        if (!text.includes(cs)) continue;
        console.log(JSON.stringify({ subject: msg.Subject, to: (msg.To ?? []).map((t) => t.Address),
          hasLink: text.includes(pub + "/app/changesets/" + cs), hasStamp: text.includes(process.env.STAMP_A),
          hasSku: text.includes("UMBRELLA-"), hasDescription: text.includes("description") }));
        return;
      }
      console.log("{}");
    })().catch((e) => console.log(JSON.stringify({ error: String(e) })));' "$MAILPIT" "$CS_A" "$MANDATE_PUBLIC_URL")"
  [[ -n "$(json "$MAIL" '.subject')" ]] && break
  sleep 3
done
OUTBOX_A="$(psql_q "select state from notification_outbox where changeset_id='$CS_A' and kind='approval_requested'" 2>&1 || true)"
if [[ "$(json "$MAIL" '.subject')" == "Approval requested: "* && "$(json "$MAIL" '.to')" == *'"content-leads@example.test"'* &&
  "$(json "$MAIL" '.hasLink')" == true && "$(json "$MAIL" '.hasStamp')" == false && "$(json "$MAIL" '.hasSku')" == false &&
  "$(json "$MAIL" '.hasDescription')" == false && "$OUTBOX_A" == sent ]]; then
  pass notification-email "Mailpit: $MAIL; notification_outbox approval_requested state: $OUTBOX_A"
else
  fail notification-email "mail=$MAIL outbox=$OUTBOX_A"
  psql_q "select kind, state, attempts, last_error from notification_outbox order by created_at" 2>/dev/null || true
fi

# 14. The credential occurs in no approval, outbox, audit or change-set row, nor in the logs (SEC-3).
T_APPROVAL="$(psql_contains approval <<<"$TOKEN" 2>&1 || true)"
T_OUTBOX="$(psql_contains notification_outbox <<<"$TOKEN" 2>&1 || true)"
T_AUDIT="$(psql_contains audit_event <<<"$TOKEN" 2>&1 || true)"
T_CS="$(psql_contains change_set <<<"$TOKEN" 2>&1 || true)"
T_CI="$(psql_contains change_item <<<"$TOKEN" 2>&1 || true)"
T_LOGS="$(compose logs --no-color api worker 2>&1 | grep -cF -f <(printf '%s\n' "$TOKEN") || true)"
C_OUTBOX="$(psql_contains notification_outbox <<<"$CS_A" 2>&1 || true)"
C_UMB="$(psql_contains change_item <<<"UMBRELLA" 2>&1 || true)"
if [[ "$T_APPROVAL" == 0 && "$T_OUTBOX" == 0 && "$T_AUDIT" == 0 && "$T_CS" == 0 && "$T_CI" == 0 && "$T_LOGS" == 0 &&
  "$C_OUTBOX" =~ ^[1-9][0-9]*$ && "$C_UMB" =~ ^[1-9][0-9]*$ ]]; then
  pass credential-absent "token in approval: 0, notification_outbox: 0, audit_event: 0, change_set: 0, change_item: 0, api and worker logs: 0 lines (controls: '$CS_A' in notification_outbox $C_OUTBOX, 'UMBRELLA' in change_item $C_UMB)"
else
  fail credential-absent "approval=$T_APPROVAL outbox=$T_OUTBOX audit=$T_AUDIT change_set=$T_CS change_item=$T_CI logs=$T_LOGS controls outbox=$C_OUTBOX umbrella=$C_UMB"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
