#!/usr/bin/env bash
# Phase 8 acceptance (SPEC section 7, designs phase-8-rollback-audit*) against the Magento sandbox:
#   sandbox-ready, stack-healthy, credential-entered;
#   group 1, rollback on the trusted page (EXE-8, UI-4, SEC-8, MCP-8): rb-prepare,
#   rb-approved-executed, rb-tool-eligible, rb-page-rollback, rb-rolled-back, rb-restored-upstream,
#   rb-second-refused, rb-audit;
#   groups 2-4 (audit, configuration, observability) are appended by the later Phase 8 plans.
# AIOPS_ACCEPT8_GROUPS selects the groups (default "1 2 3 4"); a selected group that is not
# defined is a FAIL (ADR 0043).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that joins
# the api and the worker to the sandbox network and mounts a generated configuration.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: needs the sandbox.
# Secrets: the Magento token, access tokens and session cookies travel through variables, stdin
# and the environment of node only, never through argv.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
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
