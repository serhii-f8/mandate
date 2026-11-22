#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Phase 4 acceptance (SPEC section 7, design phase-4-changesets) against the Magento sandbox:
#   prepared-explicit, before-matches-sandbox / after-matches-request, same-input-same-hash,
#   selector-prepared, other-brand-denied, zero-writes, get-and-cancel,
#   credential-absent-from-changeset-tables (SEC-3).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that
# joins the api to the sandbox network and mounts a generated configuration. Prints one
# PASS/FAIL line per check; exits non-zero if any fails. Not part of CI: needs the sandbox.
# Secrets: the Magento token travels through variables, stdin and here-strings only.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="mandate-accept4-$$"
FAILED=0
SANDBOX="http://127.0.0.1:${MANDATE_MAGENTO_PORT:-4390}"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export MANDATE_API_PORT="$(free_port)" MANDATE_KEYCLOAK_PORT="$(free_port)" MANDATE_TEMPORAL_PORT="$(free_port)" MANDATE_POSTGRES_PORT="$(free_port)"
export MANDATE_MAILPIT_PORT="$(free_port)"  # Compose runs Mailpit since Phase 6; a fixed port breaks parallel runs
export MANDATE_KEYCLOAK_PUBLIC_URL="http://localhost:${MANDATE_KEYCLOAK_PORT}"
export MANDATE_MCP_RESOURCE="http://localhost:${MANDATE_API_PORT}/mcp"
# Origin of the trusted pages and the realm's redirect URI of the mandate-web client.
export MANDATE_PUBLIC_URL="http://localhost:${MANDATE_API_PORT}"
export MANDATE_ACCEPT_CONFIG_DIR="$WORK/config"
MCP="http://127.0.0.1:${MANDATE_API_PORT}/mcp"
API="$MANDATE_PUBLIC_URL"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-4.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/mandate" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$MANDATE_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$MANDATE_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password /app/credentials; }
page_api() { MANDATE_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
mcp() { node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" "$@"; }
psql_q() { compose exec -T postgres psql -U mandate -d mandate -tAc "$1"; }
# Counts rows of a table whose JSON form contains the value on stdin's first line: the value
# reaches psql as a variable on stdin, never on a command line.
psql_contains() {
  local value
  IFS= read -r value
  printf "\\\\set v '%s'\nselect count(*) from %s t where row_to_json(t)::text like '%%' || :'v' || '%%';\n" "$value" "$1" |
    compose exec -T postgres psql -U mandate -d mandate -tA -q
}

echo "# Phase 4 acceptance of ${SHA:0:12} (project $PROJECT, api port $MANDATE_API_PORT)"

# 1b. The sandbox is up (idempotent) and seeded (idempotent); its token is the credential.
if bash "$REPO/deploy/sandbox/magento/up.sh" >"$WORK/sandbox.log" 2>&1 &&
  node "$REPO/deploy/sandbox/magento/seed.mjs" "$SANDBOX" >>"$WORK/sandbox.log" 2>&1 &&
  TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>>"$WORK/sandbox.log")" && [[ -n "$TOKEN" ]]; then
  # The seeded acme products, counted at the sandbox itself (not through the platform).
  ACME_COUNT="$(MAGENTO_TOKEN="$TOKEN" node -e "
    const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'acme', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '1' });
    fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
      .then((r) => r.json()).then((b) => console.log(b.total_count ?? ''), () => console.log(''));" "$SANDBOX")"
  if [[ "$ACME_COUNT" =~ ^[1-9][0-9]*$ ]] && docker network inspect mandate-sandbox >/dev/null 2>&1; then
    pass sandbox-ready "$(grep -o 'SANDBOX UP.*' "$WORK/sandbox.log" | tail -1); seeded acme products: $ACME_COUNT; network mandate-sandbox present"
  else
    fail sandbox-ready "acme count '$ACME_COUNT'"; exit 1
  fi
else
  fail sandbox-ready "see sandbox output below"; tail -30 "$WORK/sandbox.log"; exit 1
fi

git clone --quiet --no-local --no-checkout "$REPO" "$WORK/mandate"
git -C "$WORK/mandate" checkout --quiet --detach "$SHA"
cd "$WORK/mandate"

# The acceptance configuration: the development configuration with the sandbox URL.
mkdir -p "$MANDATE_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$MANDATE_ACCEPT_CONFIG_DIR/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$MANDATE_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }

# 1a. One command from a fresh clone.
if compose up -d --build --wait >"$WORK/up.log" 2>&1; then
  pass stack-healthy "docker compose up -d --build --wait (api on networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(compose ps -q api)" | xargs))"
else
  fail stack-healthy "see compose output below"; tail -40 "$WORK/up.log"; compose ps -a; compose logs --no-color api | tail -30; exit 1
fi


# Reads products straight from the sandbox (admin token), as {sku: {description, updated_at}}.
sandbox_products() {
  MAGENTO_TOKEN="$TOKEN" node -e "
    const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'sku', 'searchCriteria[filter_groups][0][filters][0][value]': process.argv[2], 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in', 'searchCriteria[pageSize]': '200' });
    fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
      .then((r) => r.json()).then((b) => { const o = {}; for (const i of b.items ?? []) o[i.sku] = { description: (i.custom_attributes ?? []).find((a) => a.attribute_code === 'description')?.value ?? null, updated_at: i.updated_at }; console.log(JSON.stringify(o)); }, () => console.log('{}'));" "$SANDBOX" "$1"
}
# The seeded acme SKUs, sorted, read at the sandbox itself.
ACME_SKUS="$(MAGENTO_TOKEN="$TOKEN" node -e "
  const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'acme', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '200' });
  fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
    .then((r) => r.json()).then((b) => console.log((b.items ?? []).map((i) => i.sku).sort().join(',')), () => console.log(''));" "$SANDBOX")"

# Credential, then alice.
CAROL="$(page_login carol 2>&1)" || { fail page-login-carol "$CAROL"; exit 1; }
PUT="$(page_api "$CAROL" put-credential magento-integration <<<"$TOKEN" 2>&1 || true)"
[[ "$(json "$PUT" '.status')" == 204 ]] || { fail credential-entered "$PUT"; exit 1; }
ALICE="$(login alice 2>&1)" || { fail login-alice "$ALICE"; exit 1; }

STAMP="Phase 4 acceptance $(date -u +%Y%m%dT%H%M%SZ)"
ARGS="$(node -e 'console.log(JSON.stringify({ brand: "acme", skus: ["ACME-001", "ACME-002", "ACME-404"], changes: { description: process.argv[1] } }))' "$STAMP")"
# Every seeded acme product: the selector change-set covers all of them, so all must stay unwritten.
BEFORE_P="$(sandbox_products "$ACME_SKUS")"
PREP_CIDS=()

# 1. prepared-explicit
P1="$(mcp --token "$ALICE" --tool catalog.update_content --args "$ARGS" 2>&1 || true)"
PREP_CIDS+=("$(json "$P1" '.correlationId')")
CS1="$(json "$P1" '.structuredContent.changeset.id')"
H1="$(json "$P1" '.structuredContent.changeset.hash')"
ST1="$(json "$P1" '.structuredContent.changeset.status')"
STATS1="$(json "$P1" '.structuredContent.changeset.stats')"
PEND1="$(psql_q "select count(*) from change_item where changeset_id = '$CS1' and status = 'pending'" 2>&1 || true)"
NF1="$(psql_q "select count(*) from change_item where changeset_id = '$CS1' and reason = 'not_found'" 2>&1 || true)"
if [[ "$(json "$P1" '.isError')" != true && "$ST1" == prepared && "$PEND1" == 2 && "$NF1" == 1 && "$(json "$STATS1" '.excluded.not_found')" == 1 ]]; then
  pass prepared-explicit "change-set $CS1 status $ST1, pending items $PEND1, not_found $NF1, stats $STATS1"
else
  fail prepared-explicit "result=$P1 pending=$PEND1 not_found=$NF1"
fi

# 2. before / after
BA="$(psql_q "select target_id || '|' || coalesce(before->>'description','<null>') || '|' || coalesce(after->>'description','<null>') from change_item where changeset_id = '$CS1' and status = 'pending' order by target_id" 2>&1 || true)"
BA_CHECK="$(BEFORE_P="$BEFORE_P" STAMP="$STAMP" node -e '
  const sb = JSON.parse(process.env.BEFORE_P); const rows = process.argv[1].split("\n").filter(Boolean);
  const bad = []; if (rows.length !== 2) bad.push(`rows ${rows.length}`);
  for (const r of rows) { const [sku, b, a] = r.split("|"); const want = sb[sku]?.description ?? "<null>";
    if (!(sku in sb)) bad.push(`${sku} not in sandbox`); if (b !== want) bad.push(`${sku} before differs`); if (a !== process.env.STAMP) bad.push(`${sku} after differs`); }
  console.log(bad.length ? bad.join("; ") : "ok");' "$BA" 2>&1 || true)"
if [[ "$BA_CHECK" == ok ]]; then
  pass before-matches-sandbox "stored before.description of 2 items equals the sandbox REST value"
  pass after-matches-request "stored after.description equals the requested text '$STAMP'"
else
  fail before-matches-sandbox "$BA_CHECK ($BA)"
  fail after-matches-request "$BA_CHECK"
fi

# 3. same input, same hash
P2="$(mcp --token "$ALICE" --tool catalog.update_content --args "$ARGS" 2>&1 || true)"
PREP_CIDS+=("$(json "$P2" '.correlationId')")
CS2="$(json "$P2" '.structuredContent.changeset.id')"; H2="$(json "$P2" '.structuredContent.changeset.hash')"
if [[ -n "$CS2" && "$CS2" != "$CS1" && -n "$H1" && "$H1" == "$H2" ]]; then
  pass same-input-same-hash "ids $CS1 / $CS2 differ, hash $H1 equal"
else
  fail same-input-same-hash "ids $CS1 / $CS2 hashes $H1 / $H2"
fi

# 4. selector
SARGS="$(node -e 'console.log(JSON.stringify({ brand: "acme", name_like: "%", changes: { description: process.argv[1] } }))' "$STAMP")"
P3="$(mcp --token "$ALICE" --tool catalog.update_content --args "$SARGS" 2>&1 || true)"
PREP_CIDS+=("$(json "$P3" '.correlationId')")
CS3="$(json "$P3" '.structuredContent.changeset.id')"
SEL_SKUS="$(psql_q "select string_agg(target_id, ',' order by target_id) from change_item where changeset_id = '$CS3'" 2>&1 || true)"
if [[ "$(json "$P3" '.structuredContent.changeset.status')" == prepared && -n "$ACME_SKUS" && "$SEL_SKUS" == "$ACME_SKUS" ]]; then
  pass selector-prepared "change-set $CS3 prepared; items = the seeded acme SKUs ($ACME_SKUS)"
else
  fail selector-prepared "status=$(json "$P3" '.structuredContent.changeset.status') items=$SEL_SKUS seeded=$ACME_SKUS result=$P3"
fi

# 5. other brand denied, no new change_set row
CS_BEFORE="$(psql_q "select count(*) from change_set" 2>&1 || true)"
DARGS="$(node -e 'console.log(JSON.stringify({ brand: "initech", skus: ["ACME-001"], changes: { description: process.argv[1] } }))' "$STAMP")"
P4="$(mcp --token "$ALICE" --tool catalog.update_content --args "$DARGS" 2>&1 || true)"
PREP_CIDS+=("$(json "$P4" '.correlationId')")
CS_AFTER="$(psql_q "select count(*) from change_set" 2>&1 || true)"
if [[ "$(json "$P4" '.isError')" == true && "$(json "$P4" '.text')" == "Denied by policy:"* && "$CS_BEFORE" =~ ^[0-9]+$ && "$CS_BEFORE" == "$CS_AFTER" ]]; then
  pass other-brand-denied "$(json "$P4" '.text'); change_set rows $CS_BEFORE → $CS_AFTER"
else
  fail other-brand-denied "result=$P4 rows $CS_BEFORE → $CS_AFTER"
fi

# 6. zero writes: every upstream call of the prepare calls (logged by the api and the worker) is a GET; description and updated_at of every acme product unchanged.
AFTER_P="$(sandbox_products "$ACME_SKUS")"
compose logs --no-color api worker >"$WORK/api-worker.log" 2>&1 || true
CIDS_JOINED="$(IFS=,; echo "${PREP_CIDS[*]}")"
ZW="$(CIDS="$CIDS_JOINED" node -e '
  const cids = new Set(process.env.CIDS.split(",")); let total = 0; const methods = {};
  for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
    const i = line.indexOf("{"); if (i < 0) continue; let o; try { o = JSON.parse(line.slice(i)); } catch { continue; }
    if (o.msg !== "upstream call completed" && o.message !== "upstream call completed") continue;
    if (!cids.has(o.correlationId)) continue; total++; methods[o.method] = (methods[o.method] ?? 0) + 1; }
  console.log(JSON.stringify({ total, methods }));' "$WORK/api-worker.log" 2>&1 || true)"
ZW_OK="$(node -e 'const z = JSON.parse(process.argv[1]); console.log(z.total > 0 && Object.keys(z.methods).length === 1 && z.methods.GET === z.total ? "ok" : "no")' "$ZW" 2>&1 || true)"
ZW_COVERED="$(node -e 'console.log(Object.keys(JSON.parse(process.argv[1])).sort().join(","))' "$AFTER_P" 2>&1 || true)"
if [[ "$ZW_OK" == ok && "$BEFORE_P" == "$AFTER_P" && "$BEFORE_P" != "{}" && -n "$ACME_SKUS" && "$ZW_COVERED" == "$ACME_SKUS" ]]; then
  pass zero-writes "upstream calls of the prepare calls (api and worker): $ZW (GET only); description and updated_at unchanged for all acme SKUs: $(node -e 'const o = JSON.parse(process.argv[1]); console.log(Object.entries(o).map(([k, v]) => k + "=" + v.updated_at).join(" "))' "$AFTER_P")"
else
  fail zero-writes "calls=$ZW covered=$ZW_COVERED seeded=$ACME_SKUS before=$BEFORE_P after=$AFTER_P"
fi

# 7. get_changeset and cancel_changeset
G="$(mcp --token "$ALICE" --tool get_changeset --args "{\"changeset_id\":\"$CS1\"}" 2>&1 || true)"
G_ITEMS="$(node -e 'try { const s = JSON.parse(process.argv[1]).structuredContent; console.log((s.items ?? []).length + " " + s.changeset.id) } catch { console.log("") }' "$G")"
C="$(mcp --token "$ALICE" --tool cancel_changeset --args "{\"changeset_id\":\"$CS1\"}" 2>&1 || true)"
C_ST="$(json "$C" '.structuredContent.changeset.status')"
DB_ST="$(psql_q "select status from change_set where id = '$CS1'" 2>&1 || true)"
if [[ "$G_ITEMS" == "3 $CS1" && "$(json "$G" '.isError')" != true && "$C_ST" == cancelled && "$DB_ST" == cancelled ]]; then
  pass get-and-cancel "get_changeset returned $G_ITEMS (3 items); cancel_changeset → $C_ST; db status $DB_ST"
else
  fail get-and-cancel "get=${G_ITEMS:-$G} cancel=$C db=$DB_ST"
fi

# 8. The credential occurs in no change-set table (SEC-3).
CS_ROWS="$(psql_q "select count(*) from change_set" 2>&1 || true)"
CI_ROWS="$(psql_q "select count(*) from change_item" 2>&1 || true)"
T_CS="$(psql_contains change_set <<<"$TOKEN" 2>&1 || true)"
T_CI="$(psql_contains change_item <<<"$TOKEN" 2>&1 || true)"
T_CONTROL="$(psql_contains change_item <<<"ACME-001" 2>&1 || true)"
if [[ "$CS_ROWS" =~ ^[1-9][0-9]*$ && "$CI_ROWS" =~ ^[1-9][0-9]*$ && "$T_CONTROL" =~ ^[1-9][0-9]*$ && "$T_CS" == 0 && "$T_CI" == 0 ]]; then
  pass credential-absent-from-changeset-tables "change_set ($CS_ROWS rows) and change_item ($CI_ROWS rows): token 0 (control 'ACME-001' in change_item: $T_CONTROL)"
else
  fail credential-absent-from-changeset-tables "rows=$CS_ROWS/$CI_ROWS control=$T_CONTROL cs=$T_CS ci=$T_CI"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
