#!/usr/bin/env bash
# Restart acceptance (NFR-1, NFR-2, NFR-4, EXE-4, AUD-5; design phase-10-release-quality §3.2) against
# the fake Magento catalog of packages/testing on the Compose network (`fake-magento`, 1600 products
# RST-0001..RST-1600, brand `restart`, meta_keyword `seed`):
#   setup: stack-healthy (two workers, fake-magento healthy), credential-entered (carol enters the
#   fake bearer value on the credential page);
#   group `baseline`: alice prepares catalog.update_content over SKUs 1-100 with meta_keyword
#   `v-baseline` (role restart_operator, approval never), submits, waits for `completed`, and checks
#   exactly-once at the fake and the common checks (hash unchanged, every item written,
#   `changeset.batch` audit rows = batches, `audit verify` exit 0): restart-baseline.
# Every group runs over its own SKU range so counts stay attributable (ledger ruling P1): baseline
# 1-100, api 101-400, worker 401-700, postgres 701-1000, temporal 1001-1300, pending 1301-1400 and
# 1401-1500. The fake is never reset between groups; the exactly-once check compares every SKU with
# the seed plus the values of the groups prepared so far (P11).
# AIOPS_RESTART_GROUPS selects the groups (default "baseline api worker postgres temporal pending");
# a selected group that is not defined is a FAIL `restart-groups` (ADR 0043), checked before any
# Docker work.
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that mounts the
# generated configuration, runs two worker replicas and adds the fake-magento container.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Needs no sandbox. Secrets: access tokens and session cookies travel through variables, stdin and the
# environment of node only, never argv; the fake bearer value goes to the credential page on stdin.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
# The functions run through the trap and the group dispatch, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
FAILED=0

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
result() {
  if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
  exit "$FAILED"
}

WORK="$(mktemp -d)"
PROJECT="aiops-restart-$$"
# The fake bearer value carol enters; never a real credential.
FAKE_TOKEN="restart-fake-token"
SEED_VALUE="seed"
PRODUCTS=1600
BRAND="restart"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
AIOPS_MAILPIT_PORT="$(free_port)" AIOPS_FAKE_MAGENTO_PORT="$(free_port)"
export AIOPS_API_PORT AIOPS_KEYCLOAK_PORT AIOPS_TEMPORAL_PORT AIOPS_POSTGRES_PORT AIOPS_MAILPIT_PORT AIOPS_FAKE_MAGENTO_PORT
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"
FAKE="http://127.0.0.1:${AIOPS_FAKE_MAGENTO_PORT}"
# Per change-set records the helpers keep across subshells: $STATE/<id>.hash, and $STATE/ranges with
# one "<first> <count> <value>" line per prepared range.
STATE="$WORK/state"
mkdir -p "$STATE"
: >"$STATE/ranges"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/restart.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }
running_workers() { compose ps worker --status running -q | wc -l | tr -d ' '; }
TERMINAL='^(completed|completed_with_errors|failed|cancelled|expired|rolled_back|rejected)$'

# ---- Helpers for the groups (Tasks 5-7) -----------------------------------------------------------

# fake_state: the fake's GET /_control/state as one JSON line
# ({"skus":{"RST-0001":{"submissions","applied","meta_keyword"}},"bulks":{"submitted","applied","open"}}),
# or {} when the fake does not answer.
fake_state() { curl -sf --max-time 10 "$FAKE/_control/state" || echo '{}'; }

# set_open_polls N: the fake answers N status polls per bulk with "open" before it applies the bulk.
set_open_polls() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' \
    --data "{\"n\":$1}" "$FAKE/_control/open-polls" || true)" == 204 ]]
}

# prepare_and_start FIRST COUNT VALUE [USER]: USER (default alice) prepares catalog.update_content
# over SKUs FIRST..FIRST+COUNT-1 with meta_keyword VALUE, waits until it is prepared, records the
# hash ($STATE/<id>.hash) and the range ($STATE/ranges), and submits it. Prints the change-set ID
# when the submit answers `executing` or `pending_approval`; otherwise prints the diagnosis on
# stderr and returns 1. The range is recorded before the submit, so a failed submit still counts it.
prepare_and_start() {
  local first="$1" count="$2" value="$3" user="${4:-alice}" args prep id status hash sub sub_status deadline
  args="$(node -e '
    const [first, count, value, brand] = process.argv.slice(1);
    const skus = Array.from({ length: Number(count) }, (_, i) => "RST-" + String(Number(first) + i).padStart(4, "0"));
    console.log(JSON.stringify({ brand, skus, changes: { meta_keyword: value } }));' "$first" "$count" "$value" "$BRAND")"
  prep="$(user_mcp "$user" catalog.update_content "$args")"
  id="$(json "$prep" '.structuredContent.changeset.id')"
  [[ -n "$id" ]] || id="$(json "$prep" '.structuredContent.changesetId')"
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { echo "prepare: no change-set ID: ${prep:0:1500}" >&2; return 1; }
  status="$(json "$prep" '.structuredContent.changeset.status')"
  hash="$(json "$prep" '.structuredContent.changeset.hash')"
  # A bounded wait may answer `preparing` (MCP-1); poll until it leaves preparing.
  deadline=$((SECONDS + 300))
  while [[ "$status" != prepared ]]; do
    if [[ -n "$status" && "$status" != preparing ]] || ((SECONDS >= deadline)); then
      echo "prepare: change-set $id is '$status': ${prep:0:1500}" >&2; return 1
    fi
    sleep 2
    prep="$(user_mcp "$user" get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
    status="$(json "$prep" '.structuredContent.changeset.status')"
    hash="$(json "$prep" '.structuredContent.changeset.hash')"
  done
  [[ -n "$hash" ]] || { echo "prepare: change-set $id has no hash: ${prep:0:1500}" >&2; return 1; }
  printf '%s\n' "$hash" >"$STATE/$id.hash"
  printf '%s %s %s\n' "$first" "$count" "$value" >>"$STATE/ranges"
  sub="$(user_mcp "$user" submit_for_approval "{\"changeset_id\":\"$id\",\"hash\":\"$hash\"}")"
  sub_status="$(json "$sub" '.structuredContent.status')"
  if [[ "$(json "$sub" '.isError')" == true || ! "$sub_status" =~ ^(executing|pending_approval)$ ]]; then
    echo "submit: change-set $id: ${sub:0:1500}" >&2; return 1
  fi
  echo "$id"
}

# prepared_hash ID: the hash recorded right after preparation.
prepared_hash() { cat "$STATE/$1.hash" 2>/dev/null || true; }

# wait_status ID STATUS TIMEOUT_S: reads get_changeset (as alice) every 2 s until the status equals
# STATUS, or a terminal status other than STATUS arrives, or TIMEOUT_S passes. Errors and refused
# connections (an api restart) count as "not yet". The last answer stays in WAIT_ANSWER and its
# status in WAIT_STATUS. Returns 0 on STATUS, 1 otherwise.
wait_status() {
  local id="$1" want="$2" deadline=$((SECONDS + $3))
  WAIT_ANSWER="" WAIT_STATUS=""
  while :; do
    WAIT_ANSWER="$(user_mcp alice get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
    WAIT_STATUS="$(json "$WAIT_ANSWER" '.structuredContent.changeset.status')"
    [[ "$WAIT_STATUS" == "$want" ]] && return 0
    [[ "$WAIT_STATUS" =~ $TERMINAL ]] && return 1
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}

# wait_bulk_polling ID FIRST COUNT [TIMEOUT_S]: the kill point "bulk being polled". Waits (default
# 300 s) until the fake shows, among SKUs FIRST..FIRST+COUNT-1, at least one SKU in an applied bulk
# and at least one SKU in a submitted bulk that is not applied yet, and the change-set is
# `executing`. Observed state only, no sleeps as a stand-in. Leaves the last observation in
# POLLING_SEEN. Returns 1 on timeout or when the change-set leaves `executing` first.
wait_bulk_polling() {
  local id="$1" first="$2" count="$3" deadline=$((SECONDS + ${4:-300})) seen status
  POLLING_SEEN=""
  while :; do
    seen="$(node -e '
      let s = {}; try { s = JSON.parse(process.argv[1]).skus ?? {} } catch {}
      const [first, count] = process.argv.slice(2).map(Number);
      let applied = 0, open = 0;
      for (let i = first; i < first + count; i++) {
        const e = s["RST-" + String(i).padStart(4, "0")];
        if (e === undefined) continue;
        if (e.applied > 0) applied++;
        if (e.submissions > e.applied) open++;
      }
      console.log(`${applied} ${open}`);' "$(fake_state)" "$first" "$count")"
    if [[ "${seen% *}" -ge 1 && "${seen#* }" -ge 1 ]]; then
      status="$(json "$(user_mcp alice get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")" '.structuredContent.changeset.status')"
      POLLING_SEEN="SKUs in applied bulks ${seen% *}, in open bulks ${seen#* }; change-set $status"
      [[ "$status" == executing ]] && return 0
      [[ "$status" =~ $TERMINAL ]] && return 1
    else
      POLLING_SEEN="SKUs in applied bulks ${seen% *}, in open bulks ${seen#* }"
    fi
    ((SECONDS >= deadline)) && return 1
    sleep 0.5
  done
}

# check_exactly_once FIRST COUNT VALUE: at the fake, every SKU of FIRST..FIRST+COUNT-1 has exactly one
# submission, in an applied bulk, and meta_keyword VALUE; every SKU of another prepared range
# ($STATE/ranges) the same with that range's value; every other SKU no submission and the seed value.
# Prints a one-line summary; returns 1 with the first mismatches when any SKU differs.
check_exactly_once() {
  local out
  out="$(node -e '
    const [stateJson, ranges, first, count, value, products, seed] = process.argv.slice(1);
    let s; try { s = JSON.parse(stateJson).skus } catch {}
    if (s === undefined) { console.log("no state from the fake"); process.exit(1); }
    const key = (i) => "RST-" + String(i).padStart(4, "0");
    const want = new Map();
    const lines = ranges.split("\n").filter(Boolean).map((l) => l.split(" "));
    lines.push([first, count, value]);
    for (const [f, c, v] of lines) for (let i = Number(f); i < Number(f) + Number(c); i++) want.set(key(i), v);
    const bad = []; let inRange = 0, untouched = 0;
    for (let i = 1; i <= Number(products); i++) {
      const k = key(i), e = s[k], v = want.get(k);
      if (e === undefined) { bad.push(`${k} missing`); continue; }
      if (v === undefined) {
        if (e.submissions !== 0 || e.meta_keyword !== seed) bad.push(`${k} untouched? submissions ${e.submissions} meta_keyword ${JSON.stringify(e.meta_keyword)}`);
        else untouched++;
      } else if (e.submissions !== 1 || e.applied !== 1 || e.meta_keyword !== v) {
        bad.push(`${k} submissions ${e.submissions} applied ${e.applied} meta_keyword ${JSON.stringify(e.meta_keyword)} want ${JSON.stringify(v)}`);
      } else if (i >= Number(first) && i < Number(first) + Number(count)) inRange++;
    }
    if (bad.length > 0) { console.log(`${bad.length} SKUs differ: ${bad.slice(0, 10).join("; ")}`); process.exit(1); }
    console.log(`${inRange} SKUs of ${key(Number(first))}..${key(Number(first) + Number(count) - 1)} submitted once in an applied bulk with meta_keyword ${value}; ${want.size - inRange} SKUs of earlier ranges unchanged; ${untouched} other SKUs untouched (no submission, ${seed})`);
  ' "$(fake_state)" "$(cat "$STATE/ranges")" "$1" "$2" "$3" "$PRODUCTS" "$SEED_VALUE" 2>&1)" || { echo "$out"; return 1; }
  echo "$out"
}

# check_common ID HASH: the change-set is `completed` with the prepared hash, every item `written`
# (CS-7 `already_applied` included), as many `changeset.batch` audit rows as change_batch rows, every
# batch done, and `aiops audit verify` exits 0 (AUD-5). Prints a one-line summary; returns 1 with
# the details when any part differs.
check_common() {
  local id="$1" hash="$2" answer status now_hash items batches audit_rows verify code=0
  answer="$(user_mcp alice get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
  status="$(json "$answer" '.structuredContent.changeset.status')"
  now_hash="$(json "$answer" '.structuredContent.changeset.hash')"
  items="$(psql_q "select count(*) || '|' || count(*) filter (where status = 'written') || '|' || count(*) filter (where error = 'already_applied') from change_item where changeset_id = '$id'" 2>&1 || true)"
  batches="$(psql_q "select count(*) || '|' || count(*) filter (where state = 'done') from change_batch where changeset_id = '$id'" 2>&1 || true)"
  audit_rows="$(psql_q "select count(*) from audit_event where action = 'changeset.batch' and changeset_id = '$id'" 2>&1 || true)"
  verify="$(compose exec -T api node dist/cli.js audit verify 2>&1)" || code=$?
  local i_all i_written i_applied b_all b_done
  IFS='|' read -r i_all i_written i_applied <<<"$items"
  IFS='|' read -r b_all b_done <<<"$batches"
  if [[ "$status" == completed && -n "$hash" && "$now_hash" == "$hash" && "$i_all" =~ ^[1-9][0-9]*$ && "$i_written" == "$i_all" &&
    "$b_all" =~ ^[1-9][0-9]*$ && "$b_done" == "$b_all" && "$audit_rows" == "$b_all" && "$code" == 0 ]]; then
    echo "status $status; hash unchanged ($hash); items $i_all, written $i_written (already_applied $i_applied); change_batch $b_all, done $b_done; changeset.batch audit rows $audit_rows; audit verify → exit 0: $(tail -1 <<<"$verify")"
  else
    echo "status '$status'; hash '$now_hash' want '$hash'; items $items; batches $batches; changeset.batch audit rows $audit_rows; audit verify → exit $code: $(tr '\n' '|' <<<"$verify" | head -c 600)"
    return 1
  fi
}

# ---- Group baseline: no kill; the harness itself proves exactly-once on a plain run ---------------

group_baseline() {
  local id hash out common once
  id="$(prepare_and_start 1 100 v-baseline 2>"$WORK/baseline.err")" || { fail restart-baseline "$(tr '\n' '|' <"$WORK/baseline.err")"; return 0; }
  hash="$(prepared_hash "$id")"
  if ! wait_status "$id" completed 600; then
    fail restart-baseline "change-set $id is '$WAIT_STATUS' after the wait: ${WAIT_ANSWER:0:1500}"
    compose logs --no-color worker | tail -40
    return 0
  fi
  once="$(check_exactly_once 1 100 v-baseline)" || { fail restart-baseline "exactly-once: $once"; return 0; }
  common="$(check_common "$id" "$hash")" || { fail restart-baseline "common: $common"; return 0; }
  pass restart-baseline "change-set $id: $once; $common"
}

# ---- Group selection: every selected group must be defined (ADR 0043), before any Docker work ----
# Not GROUPS: bash ignores assignments to its own GROUPS array (the user's group IDs).
RUN_GROUPS="${AIOPS_RESTART_GROUPS:-baseline api worker postgres temporal pending}"
unknown=""
for g in $RUN_GROUPS; do
  declare -F "group_$g" >/dev/null || unknown+="$g "
done
if [[ -n "$unknown" ]]; then
  echo "# Restart acceptance of ${SHA:0:12}"
  fail restart-groups "not defined: ${unknown% }"
  result
fi

# ---- Setup ----------------------------------------------------------------------------------------

echo "# Restart acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT, fake Magento port $AIOPS_FAKE_MAGENTO_PORT, groups: $RUN_GROUPS)"

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# The restart configuration, generated (not deploy/config): the preset at the version the clone
# ships (ruling P9), roles for alice (no approval), the gated support user (bob, one content_lead
# step by dave) and carol (credential ref magento-restart, ruling P7).
PRESET_VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' presets/magento2-catalog/package.json)"
[[ "$PRESET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { fail acceptance-config "preset version '$PRESET_VERSION'"; result; }
mkdir -p "$AIOPS_ACCEPT_CONFIG_DIR"
cat >"$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" <<YAML
version: 1
presets:
  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '$PRESET_VERSION' }
connections:
  - id: magento
    adapter: openapi
    base_url: http://fake-magento:3003/rest/all
    credential_ref: magento-restart
    auth: { scheme: bearer }
    preset: magento-catalog
    allow_private_network: true
YAML
cat >"$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" <<'YAML'
version: 1
roles:
  - id: restart_operator
    description: Runs the restart scenarios without approval.
    grants:
      - { operation: catalog.update_content }
    approval: { required: never }
  - id: restart_gated
    description: Prepares the pending-approval restart scenarios.
    grants:
      - { operation: catalog.update_content }
    approval: { required: always, steps: [{ role: content_lead }] }
  - id: content_lead
    grants: []
  - id: restart_admin
    grants: []
    manage_credentials: [magento-restart]
    view_audit: true
role_mapping:
  - { group: content, roles: [restart_operator] }
  - { group: support, roles: [restart_gated] }
  - { group: content-leads, roles: [content_lead] }
  - { group: admins, roles: [restart_admin] }
YAML
# 100 items per workflow run: continue-as-new happens within a 300-SKU run.
cat >"$AIOPS_ACCEPT_CONFIG_DIR/settings.yaml" <<'YAML'
version: 1
changesets: { items_per_workflow_run: 100 }
rate_limits: { mcp_user_per_minute: 6000, unauthenticated_per_minute: 6000 }
YAML

# One command from a fresh clone; two workers; the fake healthy.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  WORKERS="$(running_workers)"
  FAKE_HEALTH="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q fake-magento)")"
  FAKE_PRODUCTS="$(node -e 'try{console.log(Object.keys(JSON.parse(process.argv[1]).skus).length)}catch{console.log("")}' "$(fake_state)")"
  if [[ "$WORKERS" == 2 && "$FAKE_HEALTH" == healthy && "$FAKE_PRODUCTS" == "$PRODUCTS" ]]; then
    pass stack-healthy "docker compose up -d --build --wait; running workers: $WORKERS; fake-magento $FAKE_HEALTH with $FAKE_PRODUCTS products; preset @aiops/magento2-catalog $PRESET_VERSION"
  else
    fail stack-healthy "running workers: $WORKERS; fake-magento: $FAKE_HEALTH, products '$FAKE_PRODUCTS'"; compose ps -a; result
  fi
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api worker fake-magento | tail -40; result
fi

# carol enters the fake bearer value on the trusted credential page (stdin, never argv).
CAROL="$(page_login carol /app/credentials 2>&1)" || { fail credential-entered "page login: $CAROL"; result; }
PUT="$(page_api "$CAROL" put-credential magento-restart <<<"$FAKE_TOKEN" 2>&1 || true)"
if [[ "$(json "$PUT" '.status')" == 204 ]]; then
  pass credential-entered "carol: page login and put-credential magento-restart → 204"
else
  fail credential-entered "$PUT"; result
fi

for g in $RUN_GROUPS; do
  "group_$g"
done

result
