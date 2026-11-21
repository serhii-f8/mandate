#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Restart acceptance (NFR-1, NFR-2, NFR-4, EXE-4, AUD-5; design phase-10-release-quality §3.2) against
# the fake Magento catalog of packages/testing on the Compose network (`fake-magento`, 1600 products
# RST-0001..RST-1600, brand `restart`, meta_keyword `seed`):
#   setup: stack-healthy (two workers, fake-magento healthy), credential-entered (carol enters the
#   fake bearer value on the credential page);
#   group `baseline`: alice prepares catalog.update_content over SKUs 1-100 with meta_keyword
#   `v-baseline` (role restart_operator, approval never), submits, waits for `completed`, and checks
#   exactly-once at the fake and the common checks (hash unchanged, every item written,
#   `changeset.batch` audit rows = batches, `audit verify` exit 0): restart-baseline;
#   groups `api`, `worker`, `postgres`, `temporal`: alice prepares 300 SKUs (3 batches of the
#   preset's 100) with open-polls 8, and once the fake shows an applied bulk and an open one of the
#   range while the change-set is `executing`, the component is killed with SIGKILL (every worker
#   replica for `worker`); right after the kill the fake must still show an open bulk of the range
#   (EXE-4: the kill lands while a bulk is polled). The component is started again with `up --no-deps
#   --wait` (after PostgreSQL also Temporal, Keycloak, api and worker), two workers run and api
#   /readyz is 200; then `completed` within 300 s, the exactly-once and the common checks (300 items,
#   3 batches): restart-api (a call during the outage fails with a refused or reset connection,
#   get_changeset works after it), restart-worker, restart-postgres, restart-temporal;
#   group `pending`: bob (role restart_gated, one content_lead step) prepares and submits 100 SKUs
#   (`pending_approval`) while Mailpit is stopped, so the approval-request e-mail of the outbox fails
#   once; the worker (every replica) or Temporal is killed with SIGKILL and started again; the
#   change-set is still `pending_approval`; Mailpit starts, dave approves on the page, and the
#   change-set completes with the exactly-once and the common checks (100 items, 1 batch), and the
#   outbox delivers exactly one approval-request e-mail after the restart (NTF-3):
#   restart-worker-pending, restart-temporal-pending;
#   after all selected groups, whatever the selection: restart-no-secret (the api and worker logs are
#   not empty and never contain the fake bearer value, SEC-3).
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

# Six distinct free ports in one call: every socket stays open until all are allocated, so two
# separate calls cannot be handed the same port.
free_ports() { node -e "const n=Number(process.argv[1]),net=require('net'),ss=[];(function next(){if(ss.length===n){console.log(ss.map(s=>s.address().port).join(' '));ss.forEach(s=>s.close());return}const s=net.createServer();ss.push(s);s.listen(0,'127.0.0.1',next)})()" "$1"; }
read -r AIOPS_API_PORT AIOPS_KEYCLOAK_PORT AIOPS_TEMPORAL_PORT AIOPS_POSTGRES_PORT AIOPS_MAILPIT_PORT AIOPS_FAKE_MAGENTO_PORT <<<"$(free_ports 6)"
export AIOPS_API_PORT AIOPS_KEYCLOAK_PORT AIOPS_TEMPORAL_PORT AIOPS_POSTGRES_PORT AIOPS_MAILPIT_PORT AIOPS_FAKE_MAGENTO_PORT
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"
MAILPIT="http://127.0.0.1:${AIOPS_MAILPIT_PORT}"
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
# running SVC: the number of running containers of SVC; prints `?` and returns 1 when `compose ps`
# itself fails, so a failing Docker call never reads as 0 running.
running() {
  local out
  out="$(compose ps "$1" --status running -q 2>&1)" || { echo "?"; return 1; }
  grep -c . <<<"$out" || true
}
running_workers() { running worker; }
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

# wait_status ID STATUS TIMEOUT_S [USER]: reads get_changeset as USER (default alice; only the
# requester reads a change-set over MCP) every 2 s until the status equals STATUS, or a terminal
# status other than STATUS arrives, or TIMEOUT_S passes. Errors and refused connections (an api
# restart) count as "not yet". The last answer stays in WAIT_ANSWER and its status in WAIT_STATUS.
# Returns 0 on STATUS, 1 otherwise.
wait_status() {
  local id="$1" want="$2" deadline=$((SECONDS + $3)) user="${4:-alice}"
  WAIT_ANSWER="" WAIT_STATUS=""
  while :; do
    WAIT_ANSWER="$(user_mcp "$user" get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
    WAIT_STATUS="$(json "$WAIT_ANSWER" '.structuredContent.changeset.status')"
    [[ "$WAIT_STATUS" == "$want" ]] && return 0
    [[ "$WAIT_STATUS" =~ $TERMINAL ]] && return 1
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}

# range_counts FIRST COUNT: among SKUs FIRST..FIRST+COUNT-1 at the fake, "<applied> <open>": SKUs in
# an applied bulk, and SKUs submitted in a bulk that is not applied yet.
range_counts() {
  node -e '
    let s = {}; try { s = JSON.parse(process.argv[1]).skus ?? {} } catch {}
    const [first, count] = process.argv.slice(2).map(Number);
    let applied = 0, open = 0;
    for (let i = first; i < first + count; i++) {
      const e = s["RST-" + String(i).padStart(4, "0")];
      if (e === undefined) continue;
      if (e.applied > 0) applied++;
      if (e.submissions > e.applied) open++;
    }
    console.log(`${applied} ${open}`);' "$(fake_state)" "$1" "$2"
}

# wait_bulk_polling ID FIRST COUNT [TIMEOUT_S]: the kill point "bulk being polled". Waits (default
# 300 s) until the fake shows, among SKUs FIRST..FIRST+COUNT-1, at least one SKU in an applied bulk
# and at least one SKU in a submitted bulk that is not applied yet, and the change-set is
# `executing`; the fake is read once more after the status, so the caller kills right after an
# observation that still shows the open bulk. Observed state only, no sleeps as a stand-in. Leaves
# the last observation in POLLING_SEEN. Returns 1 on timeout or when the change-set leaves
# `executing` first.
wait_bulk_polling() {
  local id="$1" first="$2" count="$3" deadline=$((SECONDS + ${4:-300})) seen status
  POLLING_SEEN=""
  while :; do
    seen="$(range_counts "$first" "$count")"
    if [[ "${seen% *}" -ge 1 && "${seen#* }" -ge 1 ]]; then
      status="$(json "$(user_mcp alice get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")" '.structuredContent.changeset.status')"
      [[ "$status" =~ $TERMINAL ]] && { POLLING_SEEN="change-set $status"; return 1; }
      if [[ "$status" == executing ]]; then
        seen="$(range_counts "$first" "$count")"
        POLLING_SEEN="SKUs in applied bulks ${seen% *}, in open bulks ${seen#* }; change-set $status"
        [[ "${seen% *}" -ge 1 && "${seen#* }" -ge 1 ]] && return 0
      fi
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

# check_common ID HASH ITEMS BATCHES [USER]: the change-set (read as USER, default alice) is
# `completed` with the prepared hash, it has ITEMS items, every one `written` (CS-7 `already_applied`
# included), BATCHES change_batch rows, every one done, as many `changeset.batch` audit rows, and
# `aiops audit verify` exits 0 (AUD-5). Prints a one-line summary; returns 1 with the details when
# any part differs.
check_common() {
  local id="$1" hash="$2" want_items="$3" want_batches="$4" user="${5:-alice}" answer status now_hash items batches audit_rows verify code=0
  answer="$(user_mcp "$user" get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
  status="$(json "$answer" '.structuredContent.changeset.status')"
  now_hash="$(json "$answer" '.structuredContent.changeset.hash')"
  items="$(psql_q "select count(*) || '|' || count(*) filter (where status = 'written') || '|' || count(*) filter (where error = 'already_applied') from change_item where changeset_id = '$id'" 2>&1 || true)"
  batches="$(psql_q "select count(*) || '|' || count(*) filter (where state = 'done') from change_batch where changeset_id = '$id'" 2>&1 || true)"
  audit_rows="$(psql_q "select count(*) from audit_event where action = 'changeset.batch' and changeset_id = '$id'" 2>&1 || true)"
  verify="$(compose exec -T api node dist/cli.js audit verify 2>&1)" || code=$?
  local i_all i_written i_applied b_all b_done
  IFS='|' read -r i_all i_written i_applied <<<"$items"
  IFS='|' read -r b_all b_done <<<"$batches"
  if [[ "$status" == completed && -n "$hash" && "$now_hash" == "$hash" && "$i_all" == "$want_items" && "$i_written" == "$i_all" &&
    "$b_all" == "$want_batches" && "$b_done" == "$b_all" && "$audit_rows" == "$b_all" && "$code" == 0 ]]; then
    echo "status $status; hash unchanged ($hash); items $i_all, written $i_written (already_applied $i_applied); change_batch $b_all, done $b_done; changeset.batch audit rows $audit_rows; audit verify → exit 0: $(tail -1 <<<"$verify")"
  else
    echo "status '$status'; hash '$now_hash' want '$hash'; items $items (want $want_items); batches $batches (want $want_batches); changeset.batch audit rows $audit_rows; audit verify → exit $code: $(tr '\n' '|' <<<"$verify" | head -c 600)"
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
  common="$(check_common "$id" "$hash" 100 1)" || { fail restart-baseline "common: $common"; return 0; }
  pass restart-baseline "change-set $id: $once; $common"
}

# ---- Kill groups (Task 6): SIGKILL one component while a bulk is being polled ---------------------

# api_ready: GET /readyz answers 200.
api_ready() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/readyz" || true)" == 200 ]]; }

# restart_service SVC: starts SVC again and waits until it is healthy (ruling P4: `up --no-deps
# --wait`, which also brings back every worker replica). After PostgreSQL, the services that hold
# connections to it (Temporal, Keycloak, api, worker) must be healthy too (P5). Then both worker
# replicas run (NFR-4) and api /readyz is 200. Prints what it waited for; returns 1 with the Compose
# output when a service does not come back.
restart_service() {
  local svc="$1" out workers
  out="$(compose up -d --no-deps --wait "$svc" 2>&1)" || { echo "up $svc: $(tail -5 <<<"$out" | tr '\n' '|')"; return 1; }
  if [[ "$svc" == postgres ]]; then
    out="$(compose up -d --no-deps --wait temporal keycloak api worker 2>&1)" ||
      { echo "up temporal keycloak api worker: $(tail -5 <<<"$out" | tr '\n' '|')"; return 1; }
  fi
  local deadline=$((SECONDS + 120))
  until api_ready; do
    ((SECONDS >= deadline)) && { echo "api /readyz not 200 within 120 s"; return 1; }
    sleep 1
  done
  workers="$(running_workers)"
  [[ "$workers" == 2 ]] || { echo "running workers after the restart: $workers, want 2"; return 1; }
  if [[ "$svc" == postgres ]]; then
    echo "postgres, temporal, keycloak, api, worker healthy (running workers $workers); api /readyz 200"
  else
    echo "$svc healthy (running workers $workers); api /readyz 200"
  fi
}

# kill_svc SVC: SIGKILLs every container of SVC and checks that none runs any more. Prints the
# failure and returns 1 when the kill or the check fails (a failing `compose ps` is a failure).
kill_svc() {
  local left
  compose kill -s KILL "$1" >/dev/null 2>&1 || { echo "docker compose kill -s KILL $1 failed"; return 1; }
  left="$(running "$1")" || { echo "docker compose ps $1 failed after the kill"; return 1; }
  [[ "$left" == 0 ]] || { echo "$left containers of $1 still running after the kill"; return 1; }
}

# listeners: backends of the configuration LISTEN connection (CFG-3; one per api and worker process).
listeners() { psql_q "select count(*) from pg_stat_activity where application_name = 'aiops-config-listener'" 2>/dev/null | tr -d ' ' || true; }

# loops_recovered BEFORE: after a PostgreSQL restart, waits (60 s) until the LISTEN connections are
# back to BEFORE and the sealer has sealed every audit row (`audit verify` reports unsealed=0), so the
# api's listener and the worker's listener and sealer loops reconnected (Review Focus 1). Observed
# state only. Prints the observation; returns 1 when the wait ends first.
loops_recovered() {
  local before="$1" deadline=$((SECONDS + 60)) now verify unsealed
  while :; do
    now="$(listeners)"
    verify="$(compose exec -T api node dist/cli.js audit verify 2>&1 | tail -1 || true)"
    unsealed="$(grep -oE 'unsealed=[0-9]+' <<<"$verify" | cut -d= -f2 || true)"
    if [[ "$now" == "$before" && "$unsealed" == 0 ]]; then
      echo "config listeners back to $now; sealer caught up (unsealed=0)"; return 0
    fi
    ((SECONDS >= deadline)) && { echo "after 60 s: config listeners '$now' want $before; audit verify: $verify"; return 1; }
    sleep 1
  done
}

# kill_group NAME SVC FIRST COUNT VALUE: sets open-polls 8 (a bulk stays open for about 28 s of
# polls, writer.ts POLL_*), prepares and starts SKUs FIRST..FIRST+COUNT-1 (ruling P1: 300 SKUs = 3
# batches of the preset's 100), waits until a bulk is being polled, SIGKILLs every container of SVC
# and reads the fake once more: a bulk of the range must still be open, or the kill did not land
# while a bulk was polled (EXE-4). Starts SVC again, waits for `completed` and runs the exactly-once
# and common checks. Check name restart-NAME. For the api, a call during the outage must fail with a
# refused or reset connection, and get_changeset must work again after the restart (Review Focus 3).
kill_group() {
  local name="$1" svc="$2" first="$3" count="$4" value="$5" id hash once common up started killed outage="" t0 err
  t0=$SECONDS
  set_open_polls 8 || { fail "restart-$name" "open-polls 8 not accepted"; return 0; }
  id="$(prepare_and_start "$first" "$count" "$value" 2>"$WORK/$name.err")" || { fail "restart-$name" "$(tr '\n' '|' <"$WORK/$name.err")"; return 0; }
  hash="$(prepared_hash "$id")"
  local before="" loops=""
  if [[ "$svc" == postgres ]]; then
    before="$(listeners)"
    [[ "$before" =~ ^[1-9][0-9]*$ ]] || { fail "restart-$name" "config listeners before the kill: '$before'"; return 0; }
  fi
  if ! wait_bulk_polling "$id" "$first" "$count"; then
    fail "restart-$name" "change-set $id: kill point not reached: $POLLING_SEEN"
    compose logs --no-color worker | tail -40
    return 0
  fi
  started="$POLLING_SEEN"
  err="$(kill_svc "$svc")" || { fail "restart-$name" "$err"; return 0; }
  killed="$(range_counts "$first" "$count")"
  if [[ ! "${killed#* }" -ge 1 ]]; then
    fail "restart-$name" "no bulk of the range open right after the kill (SKUs in applied bulks ${killed% *}, in open bulks ${killed#* }; before the kill: $started)"
    return 0
  fi
  if [[ "$svc" == api ]]; then
    local during
    during="$(user_mcp alice get_changeset "{\"changeset_id\":\"$id\",\"page_size\":1}")"
    if [[ -n "$(json "$during" '.structuredContent.changeset.status')" || -n "$(json "$during" '.loginError')" ]] ||
      ! grep -qE 'ECONNREFUSED|ECONNRESET|fetch failed' <<<"$during"; then
      fail "restart-$name" "get_changeset during the api outage did not fail with a refused or reset connection: ${during:0:300}"; return 0
    fi
    outage="; during the outage get_changeset failed: $(grep -m1 -oE 'ECONNREFUSED|ECONNRESET|fetch failed' <<<"$during")"
  fi
  up="$(restart_service "$svc")" || { fail "restart-$name" "$up"; compose ps -a; compose logs --no-color "$svc" | tail -40; return 0; }
  if ! wait_status "$id" completed 300; then
    fail "restart-$name" "change-set $id is '$WAIT_STATUS' 300 s after the restart: ${WAIT_ANSWER:0:1500}"
    compose logs --no-color worker | tail -60
    return 0
  fi
  once="$(check_exactly_once "$first" "$count" "$value")" || { fail "restart-$name" "exactly-once: $once"; return 0; }
  common="$(check_common "$id" "$hash" "$count" $((count / 100)))" || { fail "restart-$name" "common: $common"; return 0; }
  if [[ "$svc" == postgres ]]; then
    loops="$(loops_recovered "$before")" || { fail "restart-$name" "loops: $loops"; compose logs --no-color api worker | tail -60; return 0; }
    loops="; $loops"
  fi
  pass "restart-$name" "change-set $id: killed $svc (SIGKILL, 0 containers left running) at $started; right after the kill SKUs in applied bulks ${killed% *}, in open bulks ${killed#* }; $up$outage; $once; $common$loops; wall time $((SECONDS - t0)) s"
}

group_api() { kill_group api api 101 300 v-api; }
group_worker() { kill_group worker worker 401 300 v-worker; }
group_postgres() { kill_group postgres postgres 701 300 v-postgres; }
group_temporal() { kill_group temporal temporal 1001 300 v-temporal; }

# ---- Group pending (Task 7): restart while a change-set waits for approval -------------------------

# outbox_rows ID: the change-set's notification_outbox rows, one "kind state attempts last_error" line
# each (ordered by kind).
outbox_rows() { psql_q "select kind || ' ' || state || ' ' || attempts || ' ' || coalesce(last_error, '-') from notification_outbox where changeset_id = '$1' order by kind, step, target" 2>&1 || true; }

# wait_outbox ID REGEX TIMEOUT_S: waits until the approval_requested row of the change-set matches
# REGEX ("state attempts last_error"). Observed state only. Leaves the rows in OUTBOX_SEEN.
wait_outbox() {
  local id="$1" re="$2" deadline=$((SECONDS + $3)) row
  while :; do
    OUTBOX_SEEN="$(outbox_rows "$id")"
    row="$(grep -m1 '^approval_requested ' <<<"$OUTBOX_SEEN" | cut -d' ' -f2- || true)"
    [[ "$row" =~ $re ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 1
  done
}

# approval_mails ID: the number of Mailpit messages to content-leads@example.test whose text names
# the change-set. Mailpit's search tokenizes UUIDs (ADR 0034 n): list and fetch each message.
approval_mails() {
  node -e '
    const [base, cs] = process.argv.slice(1);
    (async () => {
      const list = await (await fetch(base + "/api/v1/messages?limit=500")).json();
      let n = 0;
      for (const m of list.messages ?? []) {
        if (!(m.To ?? []).some((t) => t.Address === "content-leads@example.test")) continue;
        const msg = await (await fetch(base + "/api/v1/message/" + encodeURIComponent(m.ID))).json();
        if (String(msg.Text ?? "").includes(cs)) n++;
      }
      console.log(n);
    })().catch(() => console.log("?"));' "$MAILPIT" "$1"
}

# pending_group NAME SVC FIRST VALUE: with Mailpit stopped, bob prepares and submits SKUs
# FIRST..FIRST+99 (`pending_approval`); once the outbox recorded a failed delivery of the approval
# request, every container of SVC is SIGKILLed and started again. The change-set must still be
# `pending_approval`. Mailpit starts, dave approves on the page with the hash and count he sees, the
# change-set completes, and the exactly-once and common checks (100 items, 1 batch) pass; the outbox
# then delivers the approval request (state sent, a second attempt) as exactly one e-mail.
pending_group() {
  local name="$1" svc="$2" first="$3" value="$4" id hash err up dave view v_hash v_count dec once common mails t0
  t0=$SECONDS
  set_open_polls 1 || { fail "restart-$name" "open-polls 1 not accepted"; return 0; }
  err="$(compose stop mailpit 2>&1)" || { fail "restart-$name" "stop mailpit: $err"; return 0; }
  id="$(prepare_and_start "$first" 100 "$value" bob 2>"$WORK/$name.err")" || { fail "restart-$name" "$(tr '\n' '|' <"$WORK/$name.err")"; return 0; }
  hash="$(prepared_hash "$id")"
  wait_status "$id" pending_approval 30 bob || { fail "restart-$name" "change-set $id is '$WAIT_STATUS' after the submit, want pending_approval"; return 0; }
  # The approval request failed once while Mailpit was down; the outbox holds it for a retry.
  if ! wait_outbox "$id" '^pending [1-9][0-9]* [a-z_]+$' 60; then
    fail "restart-$name" "no failed delivery of the approval request recorded within 60 s: $(tr '\n' '|' <<<"$OUTBOX_SEEN")"; return 0
  fi
  local outbox_before="$OUTBOX_SEEN"
  err="$(kill_svc "$svc")" || { fail "restart-$name" "$err"; return 0; }
  up="$(restart_service "$svc")" || { fail "restart-$name" "$up"; compose ps -a; compose logs --no-color "$svc" | tail -40; return 0; }
  wait_status "$id" pending_approval 60 bob ||
    { fail "restart-$name" "change-set $id is '$WAIT_STATUS' after the restart, want pending_approval: ${WAIT_ANSWER:0:600}"; return 0; }
  err="$(compose up -d --no-deps --wait mailpit 2>&1)" || { fail "restart-$name" "start mailpit: $(tail -5 <<<"$err" | tr '\n' '|')"; return 0; }
  dave="$(page_login dave 2>&1)" || { fail "restart-$name" "dave page login: $dave"; return 0; }
  view="$(page_api "$dave" changeset "$id" 2>&1 || true)"
  v_hash="$(json "$view" '.body.hash')" v_count="$(json "$view" '.body.stats.included')"
  # dave approves only what was prepared: the page view must show the prepared hash and 100 items.
  if [[ -z "$hash" || "$v_hash" != "$hash" || "$v_count" != 100 ]]; then
    fail "restart-$name" "dave's page view: hash '$v_hash' (want $hash), included '$v_count' (want 100); not approved: ${view:0:600}"; return 0
  fi
  dec="$(page_api "$dave" decide "$id" approve "$hash" 100 2>&1 || true)"
  if [[ "$(json "$dec" '.status')" != 200 || ! "$(json "$dec" '.body.status')" =~ ^(approved|executing)$ ]]; then
    fail "restart-$name" "dave: decide approve $hash 100 → ${dec:0:600}"; return 0
  fi
  if ! wait_status "$id" completed 300 bob; then
    fail "restart-$name" "change-set $id is '$WAIT_STATUS' 300 s after the approval: ${WAIT_ANSWER:0:1500}"
    compose logs --no-color worker | tail -60
    return 0
  fi
  once="$(check_exactly_once "$first" 100 "$value")" || { fail "restart-$name" "exactly-once: $once"; return 0; }
  common="$(check_common "$id" "$hash" 100 1 bob)" || { fail "restart-$name" "common: $common"; return 0; }
  # First retry is due 30 s after the failed attempt (NTF-3); the dispatcher passes every 5 s.
  if ! wait_outbox "$id" '^sent ([2-9]|[1-9][0-9]+) ' 120 || grep -qv ' sent ' <<<"$OUTBOX_SEEN"; then
    fail "restart-$name" "outbox after the restart: $(tr '\n' '|' <<<"$OUTBOX_SEEN")"; return 0
  fi
  local deadline=$((SECONDS + 30))
  until mails="$(approval_mails "$id")"; [[ "$mails" =~ ^[1-9] ]] || ((SECONDS >= deadline)); do sleep 1; done
  [[ "$mails" == 1 ]] || { fail "restart-$name" "approval-request e-mails for $id in Mailpit: '$mails', want 1"; return 0; }
  pass "restart-$name" "change-set $id: pending_approval with the approval request failed in the outbox ($(tr '\n' '|' <<<"$outbox_before")); killed $svc (SIGKILL, 0 containers left running); $up; still pending_approval; dave approved $v_hash $v_count → $(json "$dec" '.body.status'); $once; $common; outbox $(tr '\n' '|' <<<"$OUTBOX_SEEN"), approval-request e-mails $mails; wall time $((SECONDS - t0)) s"
}

# no_secret: runs once after all selected groups, whatever the selection. The api and worker logs
# never contain the fake bearer value (SEC-3); the logs must not
# be empty, so the check is not vacuous.
no_secret() {
  local logs lines hits
  logs="$(compose logs --no-color api worker 2>&1)" || { fail restart-no-secret "docker compose logs api worker failed"; return 0; }
  lines="$(grep -c . <<<"$logs" || true)"
  hits="$(grep -c -F "$FAKE_TOKEN" <<<"$logs" || true)"
  if [[ "$lines" -ge 1 && "$hits" == 0 ]]; then
    pass restart-no-secret "docker compose logs api worker: $lines lines, 0 occurrences of the fake bearer value"
  else
    fail restart-no-secret "docker compose logs api worker: $lines lines, $hits occurrences of the fake bearer value"
  fi
}

group_pending() {
  pending_group worker-pending worker 1301 v-worker-pending
  pending_group temporal-pending temporal 1401 v-temporal-pending
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
# step by dave) and carol (credential ref magento-restart, ruling P7); the content_lead role gets
# approval requests by e-mail through Mailpit, so the pending groups carry the outbox across the
# restart (NTF-3).
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
notifications:
  - { id: content-leads-mail, kind: email, to: [content-leads@example.test] }
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
    notify: { approval_requests: [content-leads-mail] }
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

# One command from a fresh clone; two workers; the fake healthy; Mailpit answers.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  WORKERS="$(running_workers || true)"
  MAILPIT_OK="$(curl -sf --max-time 10 -o /dev/null "$MAILPIT/api/v1/messages" && echo ok || echo down)"
  FAKE_HEALTH="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q fake-magento)")"
  FAKE_PRODUCTS="$(node -e 'try{console.log(Object.keys(JSON.parse(process.argv[1]).skus).length)}catch{console.log("")}' "$(fake_state)")"
  if [[ "$WORKERS" == 2 && "$FAKE_HEALTH" == healthy && "$FAKE_PRODUCTS" == "$PRODUCTS" && "$MAILPIT_OK" == ok ]]; then
    pass stack-healthy "docker compose up -d --build --wait; running workers: $WORKERS; fake-magento $FAKE_HEALTH with $FAKE_PRODUCTS products; Mailpit API $MAILPIT_OK; preset @aiops/magento2-catalog $PRESET_VERSION"
  else
    fail stack-healthy "running workers: $WORKERS; fake-magento: $FAKE_HEALTH, products '$FAKE_PRODUCTS'; Mailpit API $MAILPIT_OK"; compose ps -a; result
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

# After every selected group, so the logs of every restart are searched.
no_secret

result
