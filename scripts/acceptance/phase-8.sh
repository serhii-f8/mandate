#!/usr/bin/env bash
# Phase 8 acceptance (SPEC section 7, designs phase-8-rollback-audit*) against the Magento sandbox:
#   sandbox-ready, stack-healthy, credential-entered;
#   group 1, rollback on the trusted page (EXE-8, UI-4, SEC-8, MCP-8): rb-prepare,
#   rb-approved-executed, rb-tool-eligible, rb-page-rollback, rb-rolled-back, rb-restored-upstream,
#   rb-second-refused, rb-audit;
#   group 2, audit chain (AUD-3, AUD-5): audit-sealed, audit-verify-ok, audit-tamper,
#   audit-verify-fails, audit-restore; it needs group 1's flows (at least 10 audit rows);
#   group 3, configuration apply (CFG-3, CFG-4, AUD-1): config-diff, config-apply-live, config-audit;
#   it grants dave (content_lead) catalog.search_products by editing the mounted roles.yaml, diffs and
#   applies it with the CLI, explains it, and needs no restart of the api or the worker;
#   group 4, observability (NFR-10, NFR-11, NFR-12): obs-jaeger-up, obs-trace-prepared,
#   obs-trace-workflow-run, obs-no-secrets, worker-readyz, api-readyz, metrics-names; it needs groups
#   1 to 3 on the same stack (the rollback histogram bucket exists only after group 1's rollback on
#   this worker process), so with AIOPS_ACCEPT8_GROUPS=4 alone metrics-names may FAIL. The stack runs
#   with the Compose profile `observability` (Jaeger) and exports traces to it.
# AIOPS_ACCEPT8_GROUPS selects the groups (default "1 2 3 4"); a selected group that is not
# defined is a FAIL (ADR 0043).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that joins
# the api and the worker to the sandbox network and mounts a generated configuration.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: needs the sandbox.
# Secrets: the Magento token, access tokens and session cookies travel through variables, stdin
# and the environment of node only, never through argv.
# Needs: docker with compose v2 (pulls jaegertracing/jaeger:2.23.0 for group 4), git, node, curl,
# and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept8-$$"
FAILED=0
SANDBOX="http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
export AIOPS_MAILPIT_PORT="$(free_port)"
# Group 4: the optional trace backend runs on this stack, and api and worker export to it (NFR-11).
# Exported before the trap, so `compose down -v` removes jaeger too.
export COMPOSE_PROFILES=observability OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
export AIOPS_JAEGER_PORT="$(free_port)"
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
# Origin of the trusted pages and the base of the page links in tool results (MCP-6).
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-8.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(v===undefined?'':typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password "${2:-/app/approvals}"; }
page_api() { AIOPS_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
# A user calls a tool; the user logs in again before every call, so no token expires during the run.
user_mcp() {
  local token
  token="$(login "$1" 2>&1)" || { echo "{\"loginError\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$token")}"; return 0; }
  AIOPS_MCP_TOKEN="$token" node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --tool "$2" --args "$3" 2>&1 || true
}
alice_mcp() { user_mcp alice "$@"; }
dave_mcp() { user_mcp dave "$@"; }
# The reference MCP Apps host as a user; the token reaches node through its environment.
host() {
  local user="$1" token
  shift
  token="$(login "$user" 2>&1)" || { echo "{\"errors\":[\"login $user failed\"]}"; return 0; }
  AIOPS_MCP_TOKEN="$token" node "$REPO/tooling/acceptance/widget-host.mjs" "$MCP" "$@" 2>&1 || true
}
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }
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
# A unique description per run.
stamp() { echo "Phase 8 $1 $(date -u +%Y%m%dT%H%M%SZ)"; }
# update_content arguments for comma-separated SKUs and a description.
cs_args() { node -e 'console.log(JSON.stringify({ brand: process.argv[3] ?? "umbrella", skus: process.argv[1].split(","), changes: { description: process.argv[2] } }))' "$1" "$2" ${3:+"$3"}; }
submit() { alice_mcp submit_for_approval "{\"changeset_id\":\"$1\",\"hash\":\"$2\"}"; }
# yes when no SKU of the descriptions JSON carries the value.
none_has() { node -e 'try{const o=JSON.parse(process.argv[1]);console.log(Object.keys(o).length>0&&Object.values(o).every((d)=>!String(d??"").includes(process.argv[2]))?"yes":"no")}catch{console.log("no")}' "$1" "$2"; }
# yes when every SKU in the list has exactly the value.
all_have() { node -e 'try{const o=JSON.parse(process.argv[1]);console.log(process.argv[2].split(",").every((s)=>o[s]===process.argv[3])?"yes":"no")}catch{console.log("no")}' "$1" "$2" "$3"; }
# yes when the text contains the page link of the change-set (MCP-6).
has_link() { [[ -n "$2" && "$1" == *"$AIOPS_PUBLIC_URL/app/changesets/$2"* ]] && echo yes || echo no; }
# How often the text contains the page link of the change-set.
link_count() { node -e 'console.log(process.argv[1].split(process.argv[2]).length - 1)' "$1" "$AIOPS_PUBLIC_URL/app/changesets/$2"; }
# The first text block of an mcp-call.mjs answer (the summary; content[1] is the JSON block).
text0() { json "$1" '.content[0]'; }

# The acceptance configuration: the development configuration with the sandbox URL, and roles with
# a record threshold of 2 approved by one content_lead step on the page (as in Phase 7).
# write_config DIR SRC: SRC is a deploy/config directory.
write_config() {
  local dir="$1" src="$2"
mkdir -p "$dir"
cp "$src"/*.yaml "$dir/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$dir/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$dir/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$dir/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }
if grep -lE '^(changesets|notifications):' "$dir"/*.yaml >/dev/null; then
  fail acceptance-config "the development configuration already has changesets: or notifications: ($(grep -lE '^(changesets|notifications):' "$dir"/*.yaml | xargs -n1 basename | xargs))"; exit 1
fi
cat >"$dir/roles.yaml" <<'YAML'
version: 1
notifications:
  - { id: content-leads-mail, kind: email, to: [content-leads@example.test] }
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, id: own-brands, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
      - { operation: catalog.update_content, id: own-brands-content, scope: { brand: [acme, globex, umbrella] }, deny_fields: [cost] }
    approval: { required: above_threshold, record_threshold: 2, steps: [{ role: content_lead }], allow_widget: false }
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
YAML
}

echo "# Phase 8 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"

# 1. The sandbox is up (idempotent) and seeded (idempotent); its token is the credential.
if bash "$REPO/deploy/sandbox/magento/up.sh" >"$WORK/sandbox.log" 2>&1 &&
  node "$REPO/deploy/sandbox/magento/seed.mjs" "$SANDBOX" >>"$WORK/sandbox.log" 2>&1 &&
  TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>>"$WORK/sandbox.log")" && [[ -n "$TOKEN" ]]; then
  if docker network inspect aiops-sandbox >/dev/null 2>&1; then
    pass sandbox-ready "$(grep -o 'SANDBOX UP.*' "$WORK/sandbox.log" | tail -1); $(grep -o 'SEEDED umbrella.*' "$WORK/sandbox.log" | tail -1); token present; network aiops-sandbox present"
  else
    fail sandbox-ready "network aiops-sandbox missing"; exit 1
  fi
else
  fail sandbox-ready "see sandbox output below"; tail -30 "$WORK/sandbox.log"; exit 1
fi

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

write_config "$AIOPS_ACCEPT_CONFIG_DIR" deploy/config

# 2. One command from a fresh clone; one worker; Mailpit up.
MAILPIT="http://127.0.0.1:${AIOPS_MAILPIT_PORT}"
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
# dave approves a change-set on the page: the hash and count he sees are the ones he sends.
page_approve() {
  local dave view
  dave="$(page_login dave 2>&1)" || { APPROVE="{\"loginError\":true}"; return 0; }
  view="$(page_api "$dave" changeset "$1" 2>&1 || true)"
  APPROVE_HASH="$(json "$view" '.body.hash')"
  APPROVE_COUNT="$(json "$view" '.body.stats.included')"
  APPROVE="$(page_api "$dave" decide "$1" approve "${APPROVE_HASH:-x}" "${APPROVE_COUNT:-0}" 2>&1 || true)"
}

# ---- Group 1: rollback on the trusted page (EXE-8, UI-4, SEC-8, MCP-8) ---------------------------

group_1() {
  local skus="UMBRELLA-0801,UMBRELLA-0802,UMBRELLA-0803,UMBRELLA-0804" stamp_1 cs hash before after
  local view n rb page_rb alice2 desc audit_check rb2 page_rb2 deadline

  # 1. Four changes prepared; the stored before values are what the rollback must restore.
  stamp_1="$(stamp rollback)"
  prepare "$(cs_args "$skus" "$stamp_1")" 120
  cs="$PREP_ID"
  hash="$PREP_HASH"
  view="$(alice_mcp get_changeset "{\"changeset_id\":\"${cs:-none}\",\"page_size\":4}")"
  before="$(node -e 'try{const o=JSON.parse(process.argv[1]);const b={};for(const i of o.structuredContent.items)b[i.targetId]=i.before?.description??null;console.log(JSON.stringify(b))}catch{console.log("{}")}' "$view")"
  # How many SKUs have a non-empty stored before description.
  n="$(node -e 'try{console.log(Object.values(JSON.parse(process.argv[1])).filter((d)=>typeof d==="string"&&d!=="").length)}catch{console.log(0)}' "$before")"
  if [[ "$PREP_STATUS" == prepared && "$(json "$PREP" '.structuredContent.changeset.stats.included')" == 4 && "$n" == 4 && "$before" != *"$stamp_1"* ]]; then
    pass rb-prepare "change-set $cs prepared, 4 changes, hash $hash; before $before"
  else
    fail rb-prepare "status=$PREP_STATUS before=$before answer=${PREP:0:1200}"
    return 0
  fi

  # 2. alice submits, dave approves on the page, the change-set completes and the shop has the stamp.
  local sub
  sub="$(submit "$cs" "$hash")"
  page_approve "$cs"
  poll_cs "$cs" "$TERMINAL" 300 || true
  desc="$(sandbox_descriptions "$skus")"
  if [[ "$(json "$sub" '.structuredContent.status')" == pending_approval && "$APPROVE_COUNT" == 4 && "$(json "$APPROVE" '.status')" == 200 &&
    "$POLL_STATUS" == completed && "$(all_have "$desc" "$skus" "$stamp_1")" == yes ]]; then
    pass rb-approved-executed "submit → pending_approval; dave: decide approve $APPROVE_HASH 4 → $APPROVE; then $POLL_STATUS; sandbox $desc"
  else
    fail rb-approved-executed "submit=$(json "$sub" '.structuredContent.status') decide=$APPROVE count=$APPROVE_COUNT status=$POLL_STATUS sandbox=$desc"
    return 0
  fi

  # 3. rollback_changeset offers the rollback of 4 items with the page link (MCP-8). The window
  #    opens when the workflow finishes, so the offer is awaited (bounded).
  deadline=$((SECONDS + 60))
  while :; do
    rb="$(alice_mcp rollback_changeset "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
    [[ "$(json "$rb" '.structuredContent.rollback.available')" == true ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ "$(json "$rb" '.structuredContent.rollback.available')" == true && "$(json "$rb" '.structuredContent.rollback.count')" == 4 &&
    "$(has_link "$(text0 "$rb")" "$cs")" == yes ]]; then
    pass rb-tool-eligible "rollback_changeset → $(json "$rb" '.structuredContent.rollback') — $(text0 "$rb")"
  else
    fail rb-tool-eligible "${rb:0:1200}"
    return 0
  fi

  # 4. alice logs in on the page (a fresh login) and confirms the rollback with the hash (SEC-8).
  alice2="$(page_login alice "/app/changesets/$cs" 2>&1)" || { fail rb-page-rollback "page login: $alice2"; return 0; }
  page_rb="$(page_api "$alice2" rollback "$cs" "$hash" 2>&1 || true)"
  if [[ "$(json "$page_rb" '.status')" == 200 && "$(json "$page_rb" '.body')" == '{"status":"rolling_back"}' ]]; then
    pass rb-page-rollback "alice: fresh page login; rollback $cs $hash → $page_rb"
  else
    fail rb-page-rollback "$page_rb"
    return 0
  fi

  # 5. The workflow restores every item.
  poll_cs "$cs" "$TERMINAL" 300 || true
  # Compared by value: the stats live in a jsonb column, which orders keys its own way.
  local stats
  stats="$(json "$POLL" '.structuredContent.rollback.stats')"
  if [[ "$POLL_STATUS" == rolled_back && "$(node -e 'try{const o=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.keys(o).sort().map((k)=>[k,o[k]])))}catch{console.log("")}' "$stats")" == '[["failed",0],["restored",4],["skipped",0]]' ]]; then
    pass rb-rolled-back "$cs $POLL_STATUS; rollback $(json "$POLL" '.structuredContent.rollback')"
  else
    fail rb-rolled-back "status=$POLL_STATUS rollback=$(json "$POLL" '.structuredContent.rollback')"
  fi

  # 6. Every written item has its prior value again at the shop (the acceptance criterion).
  after="$(sandbox_descriptions "$skus")"
  if [[ "$(node -e 'try{const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);const k=Object.keys(b);console.log(k.length===4&&k.every((s)=>a[s]===b[s])&&Object.keys(a).length===4?"yes":"no")}catch{console.log("no")}' "$after" "$before")" == yes ]]; then
    pass rb-restored-upstream "sandbox $after equals the stored before values"
  else
    fail rb-restored-upstream "sandbox=$after before=$before"
  fi

  # 7. A second rollback is refused in chat and on the page.
  rb2="$(alice_mcp rollback_changeset "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
  page_rb2="$(page_api "$alice2" rollback "$cs" "$hash" 2>&1 || true)"
  if [[ "$(json "$rb2" '.isError')" == true && "$(json "$rb2" '.structuredContent.rollback.reason')" == already_rolled_back && "$(json "$page_rb2" '.status')" == 409 ]]; then
    pass rb-second-refused "rollback_changeset → isError $(json "$rb2" '.structuredContent.rollback'); page rollback → $page_rb2"
  else
    fail rb-second-refused "tool=${rb2:0:800} page=$page_rb2"
  fi

  # 8. Audit: one ok changeset.rollback, completed → rolling_back by alice (the requester), then
  #    rolling_back → rolled_back; no changeset.rollback row names a SKU (SEC-3).
  audit_check="$(psql_q "select
      (select count(*) from audit_event where action = 'changeset.rollback' and outcome = 'ok' and changeset_id = '$cs')
      || ',' || (select count(*) from audit_event a join change_set c on c.id = a.changeset_id where a.action = 'changeset.transition' and a.changeset_id = '$cs'
                 and a.details->>'from' = 'completed' and a.details->>'to' = 'rolling_back' and a.actor = c.requester)
      || ',' || (select count(*) from audit_event where action = 'changeset.transition' and changeset_id = '$cs' and details->>'from' = 'rolling_back' and details->>'to' = 'rolled_back')
      || ',' || (select count(*) from audit_event where action = 'changeset.rollback' and changeset_id = '$cs' and details::text like '%UMBRELLA-%')" 2>&1 || true)"
  if [[ "$audit_check" == "1,1,1,0" ]]; then
    pass rb-audit "ok changeset.rollback, completed→rolling_back by the requester, rolling_back→rolled_back, rollback rows naming a SKU: $audit_check"
  else
    fail rb-audit "counts (rollback ok, to rolling_back by alice, to rolled_back, naming a SKU) = $audit_check"
  fi
}

# --- Groups 2–4 (audit, configuration, observability plans) are defined below this line. ---

# ---- Group 2: audit chain (AUD-3, AUD-5) ----------------------------------------------------------
# Runs after group 1's flows, which leave the audit table well above 10 rows.

audit_verify() { compose exec -T api node dist/cli.js audit verify 2>&1; }
# Runs one statement as the superuser with triggers off (session_replication_role = replica): the
# only way to alter an audit row, which the append-only trigger otherwise refuses (AUD-3).
# Its output is joined into one line, as are the refusals, so each check stays one PASS/FAIL line.
psql_replica() { compose exec -T postgres psql -U postgres -d aiops -v ON_ERROR_STOP=1 -c "SET session_replication_role = replica; $1" 2>&1 | tr '\n' ' '; }

group_2() {
  local deadline sealed out code p orig denied tampered restored

  # 1. The worker's sealer chains the rows group 1 wrote (bounded).
  deadline=$((SECONDS + 60))
  while :; do
    sealed="$(psql_q "SELECT count(*) FROM audit_event WHERE chain_pos IS NOT NULL" 2>&1 || true)"
    [[ "$sealed" =~ ^[0-9]+$ ]] && ((sealed >= 10)) && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ "$sealed" =~ ^[0-9]+$ ]] && ((sealed >= 10)); then
    pass audit-sealed "sealed rows: $sealed"
  else
    fail audit-sealed "sealed rows after 60 s: $sealed"
    return 0
  fi

  # 2. The intact chain verifies.
  code=0
  out="$(audit_verify)" || code=$?
  if [[ "$code" == 0 && "$out" =~ ^ok\ sealed=[0-9]+\ unsealed=[0-9]+\ from=[0-9]+\ head=[0-9]+:sha256:[0-9a-f]{64}$ ]]; then
    pass audit-verify-ok "aiops audit verify → exit $code: $out"
  else
    fail audit-verify-ok "exit $code: $out"
    return 0
  fi

  # 3. One sealed row is altered. The application role cannot (append-only); the superuser with
  #    triggers off can, which is the tampering verification must detect.
  p="$(psql_q "SELECT chain_pos FROM audit_event WHERE chain_pos IS NOT NULL ORDER BY chain_pos OFFSET 5 LIMIT 1" 2>&1 || true)"
  if [[ ! "$p" =~ ^[0-9]+$ ]]; then
    fail audit-tamper "no sealed position at offset 5: $p"
    return 0
  fi
  orig="$(psql_q "SELECT actor FROM audit_event WHERE chain_pos = $p" 2>&1 || true)"
  denied="$(psql_q "UPDATE audit_event SET actor = actor || '-tampered' WHERE chain_pos = $p" 2>&1 | tr '\n' ' ' || true)"
  tampered="$(psql_replica "UPDATE audit_event SET actor = actor || '-tampered' WHERE chain_pos = $p" || true)"
  if [[ "$denied" == *append-only* && "$tampered" == *"UPDATE 1"* &&
    "$(psql_q "SELECT actor FROM audit_event WHERE chain_pos = $p" 2>&1 || true)" == "$orig-tampered" ]]; then
    pass audit-tamper "chain_pos=$p actor '$orig' → '$orig-tampered'; as aiops: $denied; as superuser with replica: $tampered"
  else
    # The superuser UPDATE may have landed even though a check failed: put the row back first.
    psql_replica "UPDATE audit_event SET actor = '${orig//\'/\'\'}' WHERE chain_pos = $p" >/dev/null 2>&1 || true
    fail audit-tamper "chain_pos=$p as aiops: $denied; as superuser: $tampered"
    return 0
  fi

  # 4. Verification fails at exactly that position (the acceptance criterion).
  code=0
  out="$(audit_verify)" || code=$?
  if [[ "$code" == 1 && "$out" == "failed chain_pos=$p reason=hash_mismatch" ]]; then
    pass audit-verify-fails "aiops audit verify → exit $code: $out"
  else
    fail audit-verify-fails "exit $code: $out (expected: failed chain_pos=$p reason=hash_mismatch)"
  fi

  # 5. The row is restored the same way, so later groups start from an intact chain.
  restored="$(psql_replica "UPDATE audit_event SET actor = '${orig//\'/\'\'}' WHERE chain_pos = $p" || true)"
  code=0
  out="$(audit_verify)" || code=$?
  if [[ "$restored" == *"UPDATE 1"* && "$code" == 0 && "$out" == ok\ * ]]; then
    pass audit-restore "actor of chain_pos=$p back to '$orig'; aiops audit verify → exit $code: $out"
  else
    fail audit-restore "restore: $restored; verify exit $code: $out"
  fi
}

# ---- Group 3: configuration apply (CFG-3, CFG-4, AUD-1) -------------------------------------------
# User U is dave (group content-leads, role content_lead), operation X is catalog.search_products,
# which content_lead does not grant in the acceptance configuration.

# Whether the tools dave lists include the name: yes|no.
dave_lists() {
  local token list
  token="$(login dave 2>/dev/null || true)"
  list="$(AIOPS_MCP_TOKEN="$token" node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --list 2>&1 || true)"
  [[ "$(json "$list" ".tools.includes(\"$1\")")" == true ]] && echo yes || echo no
}
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q "$1")"; }

group_3() {
  local op=catalog.search_products before_list diff code=0 h1 h2 started_api started_worker apply listed deadline
  local apply_code=0 cnt actor services explain explain_code=0

  # 1. Dave's role lacks X; the grant is appended on disk; the CLI diff names exactly that change.
  before_list="$(dave_lists "$op")"
  sed -i '/^  - id: content_lead$/{n;s/grants: \[\]/grants: [{ operation: catalog.search_products, id: lead-search }]/}' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml"
  grep -q 'id: lead-search' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" || { fail config-diff "grant not appended to roles.yaml"; return 0; }
  diff="$(compose exec -T api node dist/cli.js config diff /etc/aiops/config 2>&1)" || code=$?
  h1="$(sed -n 's/^hash \(.*\) -> .*$/\1/p' <<<"$diff")"
  h2="$(sed -n 's/^hash .* -> \(.*\)$/\1/p' <<<"$diff")"
  if [[ "$before_list" == no && "$code" == 0 && "$(grep -c '^[+~-] ' <<<"$diff")" == 1 && "$(grep -cx '~ role content_lead: grants' <<<"$diff")" == 1 &&
    -n "$h1" && -n "$h2" && "$h1" != "$h2" ]]; then
    pass config-diff "dave lists $op: $before_list; config diff → exit $code: $(tr '\n' '|' <<<"$diff")"
  else
    fail config-diff "dave lists $op: $before_list; exit $code: $(tr '\n' '|' <<<"$diff")"
    return 0
  fi

  # 2. Apply it; the running api and worker follow without a restart (bounded).
  started_api="$(started_at api)"
  started_worker="$(started_at worker)"
  apply="$(compose exec -T api node dist/cli.js config apply /etc/aiops/config --actor acceptance 2>&1)" || apply_code=$?
  listed=no
  deadline=$((SECONDS + 60))
  while :; do
    [[ "$(dave_lists "$op")" == yes ]] && { listed=yes; break; }
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ "$apply_code" == 0 && "$listed" == yes && "$(started_at api)" == "$started_api" && "$(started_at worker)" == "$started_worker" ]]; then
    pass config-apply-live "config apply → exit $apply_code: $(tr '\n' '|' <<<"$apply"); dave lists $op; api started $started_api and worker started $started_worker unchanged"
  else
    fail config-apply-live "apply exit $apply_code: $apply; dave lists $op: $listed; api $started_api → $(started_at api); worker $started_worker → $(started_at worker)"
    return 0
  fi

  # 3. One config.apply row by cli:acceptance; both services logged config.load for the new hash;
  #    config explain answers allow for dave's group against the applied revision (POL-7).
  cnt="$(psql_q "select count(*) from audit_event where action = 'config.apply' and details->>'hash' = '$h2'" 2>&1 || true)"
  actor="$(psql_q "select actor from audit_event where action = 'config.apply' and details->>'hash' = '$h2'" 2>&1 || true)"
  deadline=$((SECONDS + 60))
  while :; do
    services="$(psql_q "select count(distinct details->>'service') from audit_event where action = 'config.load' and outcome = 'ok' and details->>'hash' = '$h2'" 2>&1 || true)"
    [[ "$services" == 2 ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  explain="$(compose exec -T api node dist/cli.js config explain --operation "$op" --groups content-leads --args '{"brand":"acme","fields":["sku"]}' 2>&1)" || explain_code=$?
  if [[ "$cnt" == 1 && "$actor" == cli:acceptance && "$services" == 2 && "$explain_code" == 0 && "$(head -n 1 <<<"$explain")" == "effect: allow" ]]; then
    pass config-audit "config.apply rows for $h2: $cnt by $actor; config.load ok from $services services; config explain → exit $explain_code: $(tr '\n' '|' <<<"$explain")"
  else
    fail config-audit "config.apply rows: $cnt by '$actor'; config.load services: $services; explain exit $explain_code: $(tr '\n' '|' <<<"$explain")"
  fi
}

# ---- Group 4: observability (NFR-10, NFR-11, NFR-12) ---------------------------------------------
# Runs last, on the same stack as groups 1 to 3 (ruling F16).

JAEGER="http://127.0.0.1:${AIOPS_JAEGER_PORT}"
# GET on a port inside a service's container (not published); prints the status, a space, the body.
in_container() { compose exec -T "$1" node -e "fetch('http://127.0.0.1:$2$3').then(async (r) => console.log(r.status, await r.text()), (e) => { console.log('000', String(e)); process.exit(1); })" 2>&1; }
# Jaeger 2.23.0 serves only its api_v3 query API (/api/v3/...; the legacy /api/services and
# /api/traces answer 404), with OTLP JSON answers: {result: {resourceSpans: [...]}}.
# Summarises such an answer (file) against the correlation ID as JSON: the trace count and ID, the
# span names, whether RunActivity:prepare carries the ID, the http.request spans of aiops-worker.
trace_summary() {
  node -e '
    const fs = require("fs");
    try {
      const text = fs.readFileSync(process.argv[1], "utf8");
      // One JSON object, or one per line when the answer is streamed in chunks.
      const bodies = text.trim().split(/\n(?=\{)/).map((l) => JSON.parse(l));
      const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue;
      const attr = (list, k) => value((list ?? []).find((x) => x.key === k)?.value);
      const spans = [];
      for (const b of bodies)
        for (const rs of b.result?.resourceSpans ?? [])
          for (const ss of rs.scopeSpans ?? [])
            for (const sp of ss.spans ?? []) spans.push({ ...sp, service: attr(rs.resource?.attributes, "service.name") });
      const ids = [...new Set(spans.map((s) => s.traceId))];
      console.log(JSON.stringify({
        traces: ids.length,
        traceID: ids[0] ?? "",
        names: [...new Set(spans.map((s) => s.name))].sort(),
        prepareTagged: spans.some((s) => s.name === "RunActivity:prepare" && attr(s.attributes, "aiops.correlation_id") === process.argv[2]),
        workerHttp: spans.filter((s) => s.name === "http.request" && s.service === "aiops-worker").length,
      }));
    } catch { console.log("{}"); }' "$1" "$2"
}
# yes when the summary has every span name in the list (space-separated).
has_spans() { node -e 'try{const n=JSON.parse(process.argv[1]).names??[];console.log(process.argv[2].split(" ").every((x)=>n.includes(x))?"yes":"no")}catch{console.log("no")}' "$1" "$2"; }
# Whether the metrics text (file) has a sample line starting with the prefix and containing every
# further argument: yes|no.
has_sample() {
  local file="$1" prefix="$2" line
  shift 2
  while IFS= read -r line; do
    [[ "$line" == "$prefix"* ]] || continue
    local ok=yes part
    for part in "$@"; do [[ "$line" == *"$part"* ]] || ok=no; done
    [[ "$ok" == yes ]] && { echo yes; return 0; }
  done <"$file"
  echo no
}
# The evidence of a refused call in one line: a tool result with isError, or the first line of the
# error mcp-call.mjs printed (an unlisted tool is refused as a JSON-RPC error, not as a result).
denial_of() {
  if [[ "$(json "$1" '.isError')" == true ]]; then
    echo "isError true: $(text0 "$1" | head -c 200)"
  else
    echo "error: $(grep -m 1 -iE 'error' <<<"$1" | head -c 200)"
  fi
}

group_4() {
  local skus="UMBRELLA-0801,UMBRELLA-0802,UMBRELLA-0803,UMBRELLA-0804" stamp_4 args denied deadline services
  local call cid cs status tags window summary trace_id expected cancel leaks readyz body api_text worker_text missing

  # 0. One call dave is not granted (no_grant), so aiops_policy_denials_total has a sample (F16).
  stamp_4="$(stamp observability)"
  args="$(cs_args "$skus" "$stamp_4")"
  denied="$(dave_mcp catalog.update_content "$args")"

  # 1. The trace backend answers (bounded).
  deadline=$((SECONDS + 60))
  while :; do
    services="$(curl -sf --max-time 5 "$JAEGER/api/v3/services" 2>/dev/null || true)"
    [[ -n "$services" ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ -n "$services" ]]; then
    pass obs-jaeger-up "GET $JAEGER/api/v3/services → $services"
  else
    fail obs-jaeger-up "no 2xx answer from $JAEGER/api/v3/services within 60 s"
    return 0
  fi

  # 2. alice's write call parks in prepared; its trace is findable by the correlation ID before the
  #    workflow closes, with the prepare activity and the upstream read (ruling R1).
  call="$(alice_mcp catalog.update_content "$args")"
  cid="$(json "$call" '.correlationId')"
  cs="$(json "$call" '.structuredContent.changeset.id')"
  [[ -n "$cs" ]] || cs="$(json "$call" '.structuredContent.changesetId')"
  status="$(json "$call" '.structuredContent.changeset.status')"
  [[ -n "$status" ]] || status="$(json "$call" '.structuredContent.status')"
  if [[ "$status" == preparing && -n "$cs" ]]; then
    poll_cs "$cs" '^[^p]|^prepared$' 120 || true
    status="$POLL_STATUS"
  fi
  if [[ -z "$cid" || -z "$cs" || "$status" != prepared ]]; then
    fail obs-trace-prepared "correlation=$cid changeset=$cs status=$status answer=${call:0:800}"
    return 0
  fi
  tags="$(node -e 'console.log(encodeURIComponent(JSON.stringify({ "aiops.correlation_id": process.argv[1] })))' "$cid")"
  # The last hour up to a minute ahead (RFC 3339, as api_v3 requires both bounds).
  window="query.start_time_min=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)&query.start_time_max=$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)"
  expected="mcp.request mcp.tool_call StartWorkflow:changesetWorkflow StartActivity:prepare RunActivity:prepare http.request"
  deadline=$((SECONDS + 30))
  while :; do
    curl -sf --max-time 5 "$JAEGER/api/v3/traces?query.service_name=aiops-api&$window&query.num_traces=5&query.attributes=$tags" >"$WORK/trace.json" 2>/dev/null || echo '{}' >"$WORK/trace.json"
    summary="$(trace_summary "$WORK/trace.json" "$cid")"
    [[ "$(json "$summary" '.traces')" == 1 && "$(has_spans "$summary" "$expected")" == yes && "$(json "$summary" '.prepareTagged')" == true &&
      "$(json "$summary" '.workerHttp')" =~ ^[1-9] ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  trace_id="$(json "$summary" '.traceID')"
  if [[ "$(json "$summary" '.traces')" == 1 && "$(has_spans "$summary" "$expected")" == yes && "$(json "$summary" '.prepareTagged')" == true &&
    "$(json "$summary" '.workerHttp')" =~ ^[1-9] ]]; then
    pass obs-trace-prepared "change-set $cs prepared; correlation $cid → trace $trace_id: $(json "$summary" '.names'); RunActivity:prepare tagged; http.request spans of aiops-worker: $(json "$summary" '.workerHttp')"
  else
    fail obs-trace-prepared "change-set $cs $status; correlation $cid; after 30 s: $summary"
    return 0
  fi

  # 3. Cancelling the change-set closes the workflow; its RunWorkflow span joins the same trace (R1).
  cancel="$(alice_mcp cancel_changeset "{\"changeset_id\":\"$cs\"}")"
  deadline=$((SECONDS + 30))
  while :; do
    curl -sf --max-time 5 "$JAEGER/api/v3/traces/$trace_id" >"$WORK/trace.json" 2>/dev/null || echo '{}' >"$WORK/trace.json"
    summary="$(trace_summary "$WORK/trace.json" "$cid")"
    [[ "$(has_spans "$summary" "RunWorkflow:changesetWorkflow")" == yes ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ "$(json "$cancel" '.structuredContent.changeset.status')" == cancelled && "$(has_spans "$summary" "RunWorkflow:changesetWorkflow")" == yes ]]; then
    pass obs-trace-workflow-run "cancel_changeset → cancelled; trace $trace_id: $(json "$summary" '.names')"
  else
    fail obs-trace-workflow-run "cancel=${cancel:0:600}; after 30 s: $summary"
  fi

  # 4. The trace carries no secret and no argument value (SEC-3): not the Magento token, not the
  #    string authorization (any case), not the description, a SKU or the brand (any case) of the call.
  #    The token reaches node through its environment only.
  leaks="$(MAGENTO_TOKEN="$TOKEN" node -e '
    const text = require("fs").readFileSync(process.argv[1], "utf8");
    const found = [];
    if (process.env.MAGENTO_TOKEN && text.includes(process.env.MAGENTO_TOKEN)) found.push("magento-token");
    if (/authorization/i.test(text)) found.push("authorization");
    // The brand in any case (the SKUs carry it upper-case), then the other values as given.
    if (/umbrella/i.test(text)) found.push("umbrella");
    for (const v of process.argv.slice(2)) if (text.includes(v)) found.push(JSON.stringify(v));
    console.log(text.length < 100 ? "trace-missing" : found.join(",") || "none");' "$WORK/trace.json" "$stamp_4" ${skus//,/ } 2>&1)"
  if [[ "$leaks" == none ]]; then
    pass obs-no-secrets "trace $trace_id ($(wc -c <"$WORK/trace.json" | tr -d ' ') bytes): no token, no authorization, no argument value"
  else
    fail obs-no-secrets "trace $trace_id contains: $leaks"
  fi

  # 5. Readiness inside the containers (ports not published): the worker and the api report Temporal ok (NFR-10, F6).
  readyz="$(in_container worker 8081 /readyz || true)"
  body="${readyz#* }"
  if [[ "${readyz%% *}" == 200 && "$(json "$body" '.temporal')" == ok ]]; then
    pass worker-readyz "worker GET 127.0.0.1:8081/readyz → $readyz"
  else
    fail worker-readyz "$readyz"
  fi
  readyz="$(in_container api 8080 /readyz || true)"
  body="${readyz#* }"
  if [[ "${readyz%% *}" == 200 && "$(json "$body" '.temporal')" == ok ]]; then
    pass api-readyz "api GET 127.0.0.1:8080/readyz → $readyz"
  else
    fail api-readyz "$readyz"
  fi

  # 6. All six metric names, scraped inside the containers (NFR-12).
  api_text="$WORK/api-metrics.txt"
  worker_text="$WORK/worker-metrics.txt"
  in_container api 9464 /metrics >"$api_text" || true
  in_container worker 8081 /metrics >"$worker_text" || true
  missing=""
  [[ "$(has_sample "$api_text" 'aiops_tool_calls_total{' 'tool="catalog.update_content"')" == yes ]] || missing+=" aiops_tool_calls_total{tool=catalog.update_content}"
  [[ "$(has_sample "$api_text" 'aiops_policy_denials_total{' 'reason="no_grant"')" == yes ]] || missing+=" aiops_policy_denials_total{reason=no_grant}"
  [[ "$(has_sample "$worker_text" 'aiops_changesets{')" == yes ]] || missing+=" aiops_changesets"
  [[ "$(has_sample "$worker_text" 'aiops_batch_duration_seconds_bucket{' 'phase="execute"')" == yes ]] || missing+=" aiops_batch_duration_seconds_bucket{phase=execute}"
  [[ "$(has_sample "$worker_text" 'aiops_batch_duration_seconds_bucket{' 'phase="rollback"')" == yes ]] || missing+=" aiops_batch_duration_seconds_bucket{phase=rollback}"
  [[ "$(has_sample "$worker_text" 'aiops_upstream_requests_total{')" == yes ]] || missing+=" aiops_upstream_requests_total"
  [[ "$(has_sample "$worker_text" 'aiops_upstream_request_duration_seconds_bucket{')" == yes ]] || missing+=" aiops_upstream_request_duration_seconds_bucket"
  if [[ -z "$missing" ]]; then
    pass metrics-names "dave catalog.update_content → $(denial_of "$denied"); api: $(grep -cE '^aiops_(tool_calls|policy_denials)_total\{' "$api_text") samples of aiops_tool_calls_total and aiops_policy_denials_total; worker: $(grep -cE '^aiops_(changesets|batch_duration_seconds_bucket|upstream_requests_total|upstream_request_duration_seconds_bucket)\{' "$worker_text") samples of the other four names"
  else
    fail metrics-names "missing:$missing; dave answer ${denied:0:400}; api $(head -c 300 "$api_text" | tr '\n' ' '); worker $(head -c 300 "$worker_text" | tr '\n' ' ')"
  fi
}

# Not GROUPS: bash ignores assignments to its own GROUPS array (the user's group IDs).
RUN_GROUPS="${AIOPS_ACCEPT8_GROUPS:-1 2 3 4}"
for g in $RUN_GROUPS; do
  if declare -F "group_$g" >/dev/null; then
    "group_$g"
  else
    fail "group-$g-missing" "not implemented yet"
  fi
done

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
