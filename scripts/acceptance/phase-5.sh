#!/usr/bin/env bash
# Phase 5 acceptance (SPEC section 7, design phase-5-execution-tasks §8) against the Magento sandbox:
#   sandbox-ready, stack-healthy (two workers), credential-entered, prepared-3000, execution-started,
#   workers-killed-mid-run, completed-3000, no-missing-writes, no-duplicate-writes-records,
#   no-duplicate-writes-magento (ADR 0029 1(j): operations above a magento_operation.id watermark),
#   drift-skipped, drift-external-value-kept, credential-absent (SEC-3).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that joins
# the api and two worker replicas to the sandbox network and mounts a generated configuration.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: needs the sandbox. A run takes about 10-20 minutes.
# Secrets: the Magento token travels through variables, stdin and the environment of node only.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept5-$$"
FAILED=0
SANDBOX="http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}"
TOTAL=3000

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
# Origin of the trusted pages and the realm's redirect URI of the aiops-web client.
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-5.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(v===undefined?'':typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password /app/credentials; }
page_api() { AIOPS_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
# alice calls a tool; she logs in again before every call, so no token expires during the long run.
alice_mcp() {
  local token
  token="$(login alice 2>&1)" || { echo "{\"loginError\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$token")}"; return 0; }
  node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --token "$token" --tool "$1" --args "$2" 2>&1 || true
}
psql_q() { compose exec -T postgres psql -U aiops -d aiops -tAc "$1"; }
# Counts rows of a table whose JSON form contains the value on stdin's first line: the value
# reaches psql as a variable on stdin, never on a command line.
psql_contains() {
  local value
  IFS= read -r value
  printf "\\\\set v '%s'\nselect count(*) from %s t where row_to_json(t)::text like '%%' || :'v' || '%%';\n" "$value" "$1" |
    compose exec -T postgres psql -U aiops -d aiops -tA -q
}
# The sandbox's own database (visibly fake development credentials of deploy/sandbox/magento/compose.yaml).
magento_db() { docker compose -p aiops-magento-sandbox -f "$REPO/deploy/sandbox/magento/compose.yaml" exec -T db mariadb -umagento -pdev-only-sandbox-db magento -N -e "$1"; }
# The SKU of a bulk operation: Magento keeps the request in serialized_data until the operation
# completes, then clears it and keeps the saved product in result_serialized_data.
OP_SKU="coalesce(json_value(convert(result_serialized_data using utf8mb4), '\$.sku'), json_value(json_value(convert(serialized_data using utf8mb4), '\$.meta_information'), '\$.product.sku'))"
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

echo "# Phase 5 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"

# 1. The sandbox is up (idempotent) and seeded (idempotent, 3000 umbrella products); its token is the credential.
if bash "$REPO/deploy/sandbox/magento/up.sh" >"$WORK/sandbox.log" 2>&1 &&
  node "$REPO/deploy/sandbox/magento/seed.mjs" "$SANDBOX" >>"$WORK/sandbox.log" 2>&1 &&
  TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>>"$WORK/sandbox.log")" && [[ -n "$TOKEN" ]]; then
  # The seeded umbrella products, counted at the sandbox itself (not through the platform).
  UMB_COUNT="$(MAGENTO_TOKEN="$TOKEN" node -e "
    const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'umbrella', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '1' });
    fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
      .then((r) => r.json()).then((b) => console.log(b.total_count ?? ''), () => console.log(''));" "$SANDBOX")"
  if [[ "$UMB_COUNT" == "$TOTAL" ]] && docker network inspect aiops-sandbox >/dev/null 2>&1; then
    pass sandbox-ready "$(grep -o 'SANDBOX UP.*' "$WORK/sandbox.log" | tail -1); $(grep -o 'SEEDED umbrella.*' "$WORK/sandbox.log" | tail -1); umbrella total_count at the sandbox: $UMB_COUNT; token present; network aiops-sandbox present"
  else
    fail sandbox-ready "umbrella count '$UMB_COUNT'"; exit 1
  fi
else
  fail sandbox-ready "see sandbox output below"; tail -30 "$WORK/sandbox.log"; exit 1
fi

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/aiops"
git -C "$WORK/aiops" checkout --quiet --detach "$SHA"
cd "$WORK/aiops"

# The acceptance configuration: the development configuration with the sandbox URL.
mkdir -p "$AIOPS_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$AIOPS_ACCEPT_CONFIG_DIR/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }
# Phase 6 gives content_manager threshold approval; this run submits 3000 items with no approver (ADR 0030).
sed -i 's/^    approval: { required: above_threshold, record_threshold: 25, steps: \[{ role: content_lead }\] }$/    approval: { required: never }/' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml"
grep -q '^    approval: { required: never }$' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" || { fail acceptance-config "approval override missing"; exit 1; }

# 2. One command from a fresh clone; two workers.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  WORKERS="$(running_workers)"
  if [[ "$WORKERS" == 2 ]]; then
    pass stack-healthy "docker compose up -d --build --wait; running workers: $WORKERS (on networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(compose ps -q worker | head -1)" | xargs))"
  else
    fail stack-healthy "running workers: $WORKERS"; compose ps -a; exit 1
  fi
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api worker | tail -30; exit 1
fi

# 3. carol enters the credential on the trusted page.
CAROL="$(page_login carol 2>&1)" || { fail credential-entered "page login: $CAROL"; exit 1; }
PUT="$(page_api "$CAROL" put-credential magento-integration <<<"$TOKEN" 2>&1 || true)"
if [[ "$(json "$PUT" '.status')" == 204 ]]; then
  pass credential-entered "carol: page login and put-credential magento-integration → 204"
else
  fail credential-entered "$PUT"; exit 1
fi

# Reads every umbrella product at the sandbox (6 pages of 500) as {count, distinct, matching, other}.
sandbox_umbrella() {
  MAGENTO_TOKEN="$TOKEN" node -e "
    const [base, want] = process.argv.slice(1); const seen = new Map();
    (async () => {
      for (let page = 1; page <= 6; page++) {
        const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'umbrella', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '500', 'searchCriteria[currentPage]': String(page), 'searchCriteria[sortOrders][0][field]': 'sku', 'searchCriteria[sortOrders][0][direction]': 'ASC', fields: 'items[sku,custom_attributes],total_count' });
        const b = await (await fetch(base + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })).json();
        for (const i of b.items ?? []) seen.set(i.sku, (i.custom_attributes ?? []).find((a) => a.attribute_code === 'description')?.value ?? null);
      }
      const other = [...seen].filter(([, d]) => d !== want).map(([s]) => s);
      console.log(JSON.stringify({ count: seen.size, matching: seen.size - other.length, other: other.slice(0, 10) }));
    })().catch((e) => console.log(JSON.stringify({ error: String(e) })));" "$SANDBOX" "$1"
}
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
}

# 4. A change-set of every umbrella product.
STAMP="Phase 5 acceptance $(date -u +%Y%m%dT%H%M%SZ)"
ARGS="$(node -e 'console.log(JSON.stringify({ brand: "umbrella", name_like: "%", changes: { description: process.argv[1] } }))' "$STAMP")"
T0=$SECONDS
prepare "$ARGS" 600
CS="$PREP_ID"
HASH="$(json "$PREP" '.structuredContent.changeset.hash')"
INCLUDED="$(json "$PREP" '.structuredContent.changeset.stats.included')"
if [[ "$(json "$PREP" '.structuredContent.changeset.status')" == prepared && "$INCLUDED" == "$TOTAL" && -n "$HASH" ]]; then
  pass prepared-3000 "change-set $CS prepared in $((SECONDS - T0)) s (first answer: $PREP_FIRST); stats $(json "$PREP" '.structuredContent.changeset.stats'); hash $HASH"
else
  fail prepared-3000 "first answer $PREP_FIRST; last answer: ${PREP:0:1500}"; exit 1
fi

# 5. Watermark of the sandbox's bulk operations, then submit.
WM="$(magento_db "select coalesce(max(id), 0) from magento_operation" 2>&1 || true)"
[[ "$WM" =~ ^[0-9]+$ ]] || { fail execution-started "watermark: $WM"; exit 1; }
SUB="$(alice_mcp submit_for_approval "{\"changeset_id\":\"$CS\",\"hash\":\"$HASH\"}")"
if [[ "$(json "$SUB" '.structuredContent.status')" == executing && "$(json "$SUB" '.structuredContent.total')" == "$TOTAL" && "$(json "$SUB" '.isError')" != true ]]; then
  pass execution-started "magento_operation watermark id $WM; submit_for_approval → $(json "$SUB" '.structuredContent') — $(json "$SUB" '.text')"
else
  fail execution-started "$SUB"; exit 1
fi

# 6. Kill every worker while 20 % <= done/total <= 80 %, then start them again.
OBSERVED=()
KILLED=""
T0=$SECONDS
while ((SECONDS - T0 < 1800)); do
  G="$(alice_mcp get_changeset "{\"changeset_id\":\"$CS\",\"page_size\":1}")"
  ST="$(json "$G" '.structuredContent.changeset.status')"
  DONE="$(json "$G" '.structuredContent.progress.done')"
  PTOTAL="$(json "$G" '.structuredContent.progress.total')"
  if [[ "$ST" =~ $TERMINAL ]]; then OBSERVED+=("$ST"); break; fi
  if [[ "$DONE" =~ ^[0-9]+$ && "$PTOTAL" =~ ^[1-9][0-9]*$ ]]; then
    PCT=$((DONE * 100 / PTOTAL))
    # One entry per distinct progress value, so the evidence stays short.
    [[ "${OBSERVED[*]: -1}" == "$DONE/$PTOTAL=${PCT}%" ]] || OBSERVED+=("$DONE/$PTOTAL=${PCT}%")
    if ((DONE * 100 > PTOTAL * 80)); then break; fi
    if ((DONE * 100 >= PTOTAL * 20)); then
      KILL_OUT="$(compose kill -s KILL worker 2>&1 || true)"
      KILLED_AT="$DONE/$PTOTAL (${PCT}%)"
      sleep 5
      AFTER_KILL="$(running_workers)"
      START_OUT="$(compose start worker 2>&1 || true)"
      sleep 2
      KILLED="yes"
      break
    fi
  fi
  sleep 1
done
WORKERS="$(running_workers)"
if [[ "$KILLED" == yes && "$AFTER_KILL" == 0 && "$WORKERS" == 2 ]]; then
  pass workers-killed-mid-run "all workers killed with SIGKILL at done $KILLED_AT; running workers 5 s later: $AFTER_KILL; after compose start: $WORKERS; observations: ${OBSERVED[*]}"
else
  fail workers-killed-mid-run "killed=${KILLED:-no} at=${KILLED_AT:-} running after kill=${AFTER_KILL:-} after start=$WORKERS observations: ${OBSERVED[*]} kill: ${KILL_OUT:-} start: ${START_OUT:-}"
fi

# 7. The run finishes: completed, 3000 written, 0 failed.
T0=$SECONDS
if poll_cs "$CS" "$TERMINAL" 1800; then :; fi
STATS="$(json "$POLL" '.structuredContent.changeset.stats')"
if [[ "$POLL_STATUS" == completed && "$(json "$STATS" '.written')" == "$TOTAL" && "$(json "$STATS" '.failed')" == 0 ]]; then
  pass completed-3000 "status $POLL_STATUS after $((SECONDS - T0)) s more; stats $STATS; $(json "$POLL" '.text' | grep -o 'completed: .*preparation)\.')"
else
  fail completed-3000 "status $POLL_STATUS stats $STATS answer ${POLL:0:1500}"
  compose logs --no-color worker | tail -40
fi

# 8. No missing writes: every umbrella SKU carries STAMP at the sandbox, every item is written.
SB="$(sandbox_umbrella "$STAMP")"
WRITTEN="$(psql_q "select count(*) from change_item where changeset_id = '$CS' and status = 'written'" 2>&1 || true)"
if [[ "$(json "$SB" '.count')" == "$TOTAL" && "$(json "$SB" '.matching')" == "$TOTAL" && "$WRITTEN" == "$TOTAL" ]]; then
  pass no-missing-writes "sandbox: $(json "$SB" '.matching') of $(json "$SB" '.count') umbrella SKUs have description '$STAMP'; change_item written: $WRITTEN"
else
  fail no-missing-writes "sandbox $SB; change_item written: $WRITTEN"
fi

# 9. No duplicate writes in our records (ruling F8: targets counted over target_ids).
BATCH_ROWS="$(psql_q "select count(*) || '|' || count(*) filter (where state = 'done') from change_batch where changeset_id = '$CS'" 2>&1 || true)"
TARGETS="$(psql_q "select count(*) || '|' || count(distinct t) from change_batch b, jsonb_array_elements_text(b.target_ids) t where b.changeset_id = '$CS'" 2>&1 || true)"
WRITE_BATCHES="$(psql_q "select count(*) || '|' || count(upstream_batch_id) || '|' || count(distinct upstream_batch_id) from change_batch b where b.changeset_id = '$CS' and exists (select 1 from jsonb_array_elements(coalesce(b.plan, '[]'::jsonb)) e where e->>'action' = 'write')" 2>&1 || true)"
RETRIED="$(psql_q "select count(*) filter (where attempt > 1) || '|' || coalesce(max(attempt), 0) from change_batch where changeset_id = '$CS'" 2>&1 || true)"
IFS='|' read -r B_ALL B_DONE <<<"$BATCH_ROWS"
IFS='|' read -r T_ALL T_DISTINCT <<<"$TARGETS"
IFS='|' read -r W_ALL W_IDS W_DISTINCT <<<"$WRITE_BATCHES"
IFS='|' read -r R_COUNT R_MAX <<<"$RETRIED"
if [[ "$B_ALL" =~ ^[1-9][0-9]*$ && "$B_ALL" == "$B_DONE" && "$T_ALL" == "$TOTAL" && "$T_DISTINCT" == "$TOTAL" &&
  "$W_ALL" =~ ^[1-9][0-9]*$ && "$W_IDS" == "$W_ALL" && "$W_DISTINCT" == "$W_ALL" ]]; then
  pass no-duplicate-writes-records "change_batch: $B_ALL rows, $B_DONE done; target_ids $T_ALL entries, $T_DISTINCT distinct; batches with a write entry: $W_ALL, upstream_batch_id set $W_IDS, distinct $W_DISTINCT; batches claimed more than once: $R_COUNT (max attempt $R_MAX)"
else
  fail no-duplicate-writes-records "batches=$BATCH_ROWS targets=$TARGETS write_batches=$WRITE_BATCHES retried=$RETRIED"
  psql_q "select batch_no, attempt, state, upstream_batch_id, jsonb_array_length(target_ids), jsonb_array_length(coalesce(plan, '[]'::jsonb)) from change_batch where changeset_id = '$CS' order by batch_no" || true
fi

# 10. No duplicate writes at Magento: over the bulk operations created since the run started
# (id above the watermark), each SKU in exactly one operation, 3000 SKUs, and the bulks are
# exactly our recorded submissions.
MG_DUPS="$(magento_db "select count(*) from (select $OP_SKU sku from magento_operation where id > $WM group by sku having count(*) > 1) d" 2>&1 || true)"
MG_COUNTS="$(magento_db "select concat(count(*), '|', count(distinct $OP_SKU), '|', count(distinct bulk_uuid), '|', sum($OP_SKU is null), '|', group_concat(distinct status order by status)) from magento_operation where id > $WM" 2>&1 || true)"
IFS='|' read -r M_OPS M_SKUS M_BULKS M_NOSKU M_STATUSES <<<"$MG_COUNTS"
MG_BULK_IDS="$(magento_db "select distinct convert(bulk_uuid using utf8mb4) from magento_operation where id > $WM order by 1" 2>&1 | sort || true)"
OUR_BULK_IDS="$(psql_q "select upstream_batch_id from change_batch where changeset_id = '$CS' and upstream_batch_id is not null order by 1" 2>&1 | sort || true)"
if [[ "$MG_DUPS" == 0 && "$M_SKUS" == "$TOTAL" && "$M_OPS" == "$TOTAL" && "$M_NOSKU" == 0 && "$M_BULKS" == "$W_ALL" && -n "$MG_BULK_IDS" && "$MG_BULK_IDS" == "$OUR_BULK_IDS" ]]; then
  pass no-duplicate-writes-magento "magento_operation above id $WM: $M_OPS operations, $M_SKUS distinct SKUs, SKUs in more than one operation: $MG_DUPS; operation statuses: $M_STATUSES; bulks $M_BULKS = done batches with a write entry $W_ALL; the bulk UUIDs equal the recorded upstream_batch_ids"
else
  fail no-duplicate-writes-magento "dups=$MG_DUPS counts=$MG_COUNTS write_batches=$W_ALL bulk ids equal: $([[ "$MG_BULK_IDS" == "$OUR_BULK_IDS" ]] && echo yes || echo no)"
  echo "# change_batch rows:"; psql_q "select batch_no, attempt, state, upstream_batch_id, jsonb_array_length(target_ids) from change_batch where changeset_id = '$CS' order by batch_no" || true
  echo "# Magento bulks above the watermark:"; magento_db "select convert(bulk_uuid using utf8mb4), count(*), min(id), max(id) from magento_operation where id > $WM group by bulk_uuid order by min(id)" || true
  echo "# SKUs in more than one operation:"; magento_db "select $OP_SKU sku, count(*), group_concat(convert(bulk_uuid using utf8mb4)) from magento_operation where id > $WM group by sku having count(*) > 1 limit 20" || true
fi

# 11. Drift: three items prepared, one changed through Magento REST, then executed.
STAMP2="Phase 5 drift $(date -u +%Y%m%dT%H%M%SZ)"
EXTERNAL="External change $(date -u +%Y%m%dT%H%M%SZ)"
DSKUS="UMBRELLA-0001,UMBRELLA-0002,UMBRELLA-0003"
DARGS="$(node -e 'console.log(JSON.stringify({ brand: "umbrella", skus: ["UMBRELLA-0001", "UMBRELLA-0002", "UMBRELLA-0003"], changes: { description: process.argv[1] } }))' "$STAMP2")"
prepare "$DARGS" 120
CSD="$PREP_ID"
HASHD="$(json "$PREP" '.structuredContent.changeset.hash')"
DSTATUS="$(json "$PREP" '.structuredContent.changeset.status')"
PUT_STATUS="$(MAGENTO_TOKEN="$TOKEN" node -e "
  fetch(process.argv[1] + '/rest/all/V1/products/UMBRELLA-0002', { method: 'PUT', headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ product: { sku: 'UMBRELLA-0002', custom_attributes: [{ attribute_code: 'description', value: process.argv[2] }] } }) })
    .then((r) => console.log(r.status), (e) => console.log(String(e)));" "$SANDBOX" "$EXTERNAL")"
DSUB="$(alice_mcp submit_for_approval "{\"changeset_id\":\"$CSD\",\"hash\":\"$HASHD\"}")"
poll_cs "$CSD" "$TERMINAL" 600 10 || true
DITEMS="$(node -e '
  try { const s = JSON.parse(process.argv[1]).structuredContent; console.log((s.items ?? []).map((i) => `${i.targetId}=${i.status}${i.error ? "/" + i.error : ""}`).sort().join(" ")) } catch { console.log("") }' "$POLL")"
if [[ "$DSTATUS" == prepared && "$PUT_STATUS" == 200 && "$(json "$DSUB" '.structuredContent.status')" == executing &&
  "$DITEMS" == "UMBRELLA-0001=written UMBRELLA-0002=skipped/drift UMBRELLA-0003=written" ]]; then
  pass drift-skipped "change-set $CSD prepared; external PUT UMBRELLA-0002 → $PUT_STATUS; after execution ($POLL_STATUS): $DITEMS — $(json "$POLL" '.text' | grep -o '[a-z_]*: [0-9]* written.*preparation)\.')"
else
  fail drift-skipped "prepared=$DSTATUS put=$PUT_STATUS submit=$DSUB status=$POLL_STATUS items=$DITEMS"
fi

# 12. The changed product keeps the external value; the others carry STAMP2.
DDESC="$(sandbox_descriptions "$DSKUS")"
DCHECK="$(STAMP2="$STAMP2" EXTERNAL="$EXTERNAL" node -e '
  const o = JSON.parse(process.argv[1]); const e = process.env;
  console.log(o["UMBRELLA-0001"] === e.STAMP2 && o["UMBRELLA-0002"] === e.EXTERNAL && o["UMBRELLA-0003"] === e.STAMP2 ? "ok" : "no")' "$DDESC" 2>&1 || true)"
if [[ "$DCHECK" == ok ]]; then
  pass drift-external-value-kept "sandbox descriptions: $DDESC"
else
  fail drift-external-value-kept "sandbox descriptions: $DDESC (want 0002 '$EXTERNAL', others '$STAMP2')"
fi

# 13. The credential occurs in neither mcp_task nor change_batch (SEC-3), nor in the change-set tables.
T_TASK="$(psql_contains mcp_task <<<"$TOKEN" 2>&1 || true)"
T_BATCH="$(psql_contains change_batch <<<"$TOKEN" 2>&1 || true)"
T_CS="$(psql_contains change_set <<<"$TOKEN" 2>&1 || true)"
T_CI="$(psql_contains change_item <<<"$TOKEN" 2>&1 || true)"
C_UMB="$(psql_contains change_item <<<"UMBRELLA" 2>&1 || true)"
C_BATCH="$(psql_contains change_batch <<<"UMBRELLA" 2>&1 || true)"

TASK_ROWS="$(psql_q "select count(*) from mcp_task" 2>&1 || true)"
if [[ "$T_TASK" == 0 && "$T_BATCH" == 0 && "$T_CS" == 0 && "$T_CI" == 0 && "$C_UMB" =~ ^[1-9][0-9]*$ && "$C_BATCH" =~ ^[1-9][0-9]*$ && "$TASK_ROWS" =~ ^[0-9]+$ ]]; then
  pass credential-absent "token in mcp_task ($TASK_ROWS rows): 0, change_batch: 0, change_set: 0, change_item: 0 (controls: 'UMBRELLA' in change_item $C_UMB, in change_batch $C_BATCH)"
else
  fail credential-absent "mcp_task=$T_TASK change_batch=$T_BATCH change_set=$T_CS change_item=$T_CI controls umbrella=$C_UMB batch=$C_BATCH task_rows=$TASK_ROWS"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
