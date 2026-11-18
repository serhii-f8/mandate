#!/usr/bin/env bash
# Phase 7 acceptance (SPEC section 7, designs phase-7-widgets*) against the Magento sandbox:
#   sandbox-ready, stack-healthy, credential-entered, widgets-in-image;
#   group 1, the terminal client (text fallback, MCP-6): text-prepare, text-get, text-exclude,
#   text-submit, text-review, page-approve, excluded-unchanged, export-csv, export-xlsx,
#   page-url-answers, no-link-without-changeset;
#   group 2, the reference MCP Apps host in headless Chromium (MCP-5, UI-6): host-build,
#   host-tool-links-resource, host-preview-exclude-submit, host-csp-blocks-fetch, host-theme-applied,
#   host-result-counts, host-approval-default, reconfigure-allow-widget, host-approval-widget-decides.
# Then prints the MANUAL CHECKS for Claude Desktop and ChatGPT (criteria 1 and 2).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that joins
# the api and the worker to the sandbox network and mounts a generated configuration.
# Prints one PASS/FAIL line per check and `# RESULT: PASS (automated checks)|FAIL`; exits non-zero
# if any fails. Not part of CI: needs the sandbox and the cached Chromium of Playwright 1.65.1.
# Secrets: the Magento token, access tokens and session cookies travel through variables, stdin
# and the environment of node only, never through argv.
# Needs: docker with compose v2, git, node, curl, unzip, and `pnpm install` in this checkout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
WORK="$(mktemp -d)"
PROJECT="aiops-accept7-$$"
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

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-7.compose.yaml "$@"; }

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
  node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --token "$token" --tool "$2" --args "$3" 2>&1 || true
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
# The leading `=` proves the export's formula safety; the shop stores it as plain text.
stamp() { echo "=1+1 Phase 7 $1 $(date -u +%Y%m%dT%H%M%SZ)"; }
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

echo "# Phase 7 acceptance of ${SHA:0:12} (project $PROJECT, api port $AIOPS_API_PORT)"

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

# The acceptance configuration: the development configuration with the sandbox URL, and roles with
# a record threshold of 2 whose approver may not decide in the widget (yet; check 21 allows it).
mkdir -p "$AIOPS_ACCEPT_CONFIG_DIR"
cp deploy/config/*.yaml "$AIOPS_ACCEPT_CONFIG_DIR/"
sed -i 's#^\(    base_url: \).*#\1http://magento-sandbox/rest/all#' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml"
grep -q '^    base_url: http://magento-sandbox/rest/all$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "base_url not replaced"; exit 1; }
grep -q '^    allow_private_network: true$' "$AIOPS_ACCEPT_CONFIG_DIR/connections.yaml" || { fail acceptance-config "allow_private_network missing"; exit 1; }
if grep -lE '^(changesets|notifications):' "$AIOPS_ACCEPT_CONFIG_DIR"/*.yaml >/dev/null; then
  fail acceptance-config "the development configuration already has changesets: or notifications: ($(grep -lE '^(changesets|notifications):' "$AIOPS_ACCEPT_CONFIG_DIR"/*.yaml | xargs -n1 basename | xargs))"; exit 1
fi
cat >"$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" <<'YAML'
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

# 4. The api image ships both widget bundles (MCP-5).
WIDGETS="$(compose exec -T api ls /app/widgets 2>&1 || true)"
if grep -qx approval.html <<<"$WIDGETS" && grep -qx changeset.html <<<"$WIDGETS"; then
  pass widgets-in-image "compose exec api ls /app/widgets → $(xargs <<<"$WIDGETS")"
else
  fail widgets-in-image "$WIDGETS"
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

# ---- Group 1: the terminal client sees the text fallback (MCP-6) --------------------------------

# 5. Four changes: prepared, the text names the count, the hash and the page link.
SKUS_1="UMBRELLA-0301,UMBRELLA-0302,UMBRELLA-0303,UMBRELLA-0304"
STAMP_1="$(stamp text-prepare)"
prepare "$(cs_args "$SKUS_1" "$STAMP_1")" 120
CS_1="$PREP_ID"
HASH_1="$PREP_HASH"
T1="$(text0 "$PREP")"
PAGE_URL_1="$(json "$PREP" '.structuredContent.pageUrl')"
if [[ "$PREP_STATUS" == prepared && "$T1" == *"4 change(s)"* && -n "$HASH_1" && "$T1" == *"$HASH_1"* &&
  "$(has_link "$T1" "$CS_1")" == yes && "$PAGE_URL_1" == "$AIOPS_PUBLIC_URL/app/changesets/$CS_1" ]]; then
  pass text-prepare "change-set $CS_1 $PREP_STATUS (first answer $PREP_FIRST); pageUrl $PAGE_URL_1 — $T1"
else
  fail text-prepare "status=$PREP_STATUS first=$PREP_FIRST pageUrl=$PAGE_URL_1 answer=${PREP:0:1200}"
fi

# 6. get_changeset also carries the link.
G_1="$(alice_mcp get_changeset "{\"changeset_id\":\"$CS_1\",\"page_size\":1}")"
if [[ "$(has_link "$(text0 "$G_1")" "$CS_1")" == yes ]]; then
  pass text-get "get_changeset $CS_1 — $(text0 "$G_1")"
else
  fail text-get "${G_1:0:1000}"
fi

# 7. Excluding one item yields a new change-set and hash; the source is unchanged (CS-5).
EX="$(alice_mcp exclude_changeset_items "{\"changeset_id\":\"$CS_1\",\"hash\":\"$HASH_1\",\"exclude\":[\"UMBRELLA-0304\"]}")"
CS_N="$(json "$EX" '.structuredContent.changeset.id')"
HASH_N="$(json "$EX" '.structuredContent.changeset.hash')"
G_1B="$(alice_mcp get_changeset "{\"changeset_id\":\"$CS_1\",\"page_size\":1}")"
if [[ -n "$CS_N" && "$CS_N" != "$CS_1" && -n "$HASH_N" && "$HASH_N" != "$HASH_1" && "$(has_link "$(text0 "$EX")" "$CS_N")" == yes &&
  "$(json "$G_1B" '.structuredContent.changeset.status')" == prepared && "$(json "$G_1B" '.structuredContent.changeset.hash')" == "$HASH_1" ]]; then
  pass text-exclude "new change-set $CS_N hash $HASH_N (source $CS_1 still prepared, hash $HASH_1) — $(text0 "$EX")"
else
  fail text-exclude "exclude=${EX:0:1000} source=${G_1B:0:600}"
fi

# 8. Submitting the new change-set: pending approval, the page URL exactly once in the text.
SUB_N="$(submit "$CS_N" "$HASH_N")"
T_SUB_N="$(text0 "$SUB_N")"
if [[ "$(json "$SUB_N" '.structuredContent.status')" == pending_approval && "$(link_count "$T_SUB_N" "$CS_N")" == 1 ]]; then
  pass text-submit "submit $CS_N → pending_approval; page URL once — $T_SUB_N"
else
  fail text-submit "links=$(link_count "$T_SUB_N" "$CS_N") answer=${SUB_N:0:1000}"
fi

# 9. dave reviews in chat: the widget may not decide (allow_widget false), the text has the link.
REV_N="$(dave_mcp review_changeset "{\"changeset_id\":\"$CS_N\"}")"
if [[ "$(json "$REV_N" '.structuredContent.detail.viewer.canDecide')" == false &&
  "$(json "$REV_N" '.structuredContent.detail.viewer.reason')" == widget_not_allowed && "$(has_link "$(text0 "$REV_N")" "$CS_N")" == yes ]]; then
  pass text-review "dave: review_changeset $CS_N → viewer $(json "$REV_N" '.structuredContent.detail.viewer') — $(text0 "$REV_N")"
else
  fail text-review "${REV_N:0:1500}"
fi

# 10. dave approves on the page; the change-set completes.
page_approve "$CS_N"
poll_cs "$CS_N" "$TERMINAL" 300 || true
if [[ "$APPROVE_COUNT" == 3 && -n "$APPROVE_HASH" && "$(json "$APPROVE" '.status')" == 200 && "$POLL_STATUS" == completed ]]; then
  pass page-approve "dave: changeset $CS_N hash $APPROVE_HASH included $APPROVE_COUNT; decide approve → $APPROVE; then $POLL_STATUS"
else
  fail page-approve "hash=$APPROVE_HASH count=$APPROVE_COUNT decide=$APPROVE status=$POLL_STATUS"
fi

# 11. The excluded item stayed as it was in the shop.
DESC_1="$(sandbox_descriptions "$SKUS_1")"
if [[ "$(all_have "$DESC_1" "UMBRELLA-0301,UMBRELLA-0302,UMBRELLA-0303" "$STAMP_1")" == yes &&
  -n "$(json "$DESC_1" '["UMBRELLA-0304"]')" && "$(json "$DESC_1" '["UMBRELLA-0304"]')" != *"$STAMP_1"* ]]; then
  pass excluded-unchanged "sandbox $DESC_1"
else
  fail excluded-unchanged "sandbox $DESC_1"
fi

# 12. CSV export from alice's page session: every item, the excluded one too, formula-safe (CS-8).
ALICE="$(page_login alice 2>&1)" || { fail export-csv "page login: $ALICE"; ALICE=""; }
EXP_CSV="$(page_api "$ALICE" export "$CS_N" csv "$WORK/export.csv" 2>&1 || true)"
CSV_CHECK="$(node -e '
  // The export starts with a UTF-8 BOM (for spreadsheet programs); the header follows it.
  const raw = require("fs").readFileSync(process.argv[1], "utf8");
  const bom = raw.startsWith("\uFEFF");
  const text = bom ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  // A minimal RFC 4180 split of one line (the stamps carry no line breaks).
  const cells = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === "\"" && l[i + 1] === "\"") { cur += "\""; i++; } else if (c === "\"") q = false; else cur += c; }
    else if (c === "\"") q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; };
  const head = cells(lines[0]);
  const row = lines.slice(1).map(cells).find((r) => r[head.indexOf("target_id")] === "UMBRELLA-0301");
  console.log(JSON.stringify({ bom, lines: lines.length, headerOk: lines[0].startsWith("\"target_id\",\"status\",\"reason\",\"error\""),
    after: row?.[head.indexOf("after.description")] ?? null }));' "$WORK/export.csv" 2>/dev/null || echo '{}')"
if [[ "$(json "$EXP_CSV" '.status')" == 200 && "$(json "$CSV_CHECK" '.lines')" == 5 && "$(json "$CSV_CHECK" '.headerOk')" == true &&
  "$(json "$CSV_CHECK" '.after')" == "'=1+1"* ]]; then
  pass export-csv "alice: export $CS_N csv → $EXP_CSV; $CSV_CHECK"
else
  fail export-csv "export=$EXP_CSV check=$CSV_CHECK head=$(head -c 400 "$WORK/export.csv" 2>/dev/null | tr '\n' '|')"
fi

# 13. XLSX export: 5 rows, the formula-safe text and no formula cell.
EXP_XLSX="$(page_api "$ALICE" export "$CS_N" xlsx "$WORK/export.xlsx" 2>&1 || true)"
SHEET="$(unzip -p "$WORK/export.xlsx" 'xl/worksheets/*.xml' 2>/dev/null || true)"
XLSX_ROWS="$(grep -o '<row' <<<"$SHEET" | wc -l | tr -d ' ')"
if [[ "$(json "$EXP_XLSX" '.status')" == 200 && "$XLSX_ROWS" == 5 && "$SHEET" == *"'=1+1"* && "$SHEET" != *"<f>"* && "$SHEET" != *"<f "* ]]; then
  pass export-xlsx "alice: export $CS_N xlsx → $EXP_XLSX; worksheet rows: $XLSX_ROWS; contains '=1+1; no <f>"
else
  fail export-xlsx "export=$EXP_XLSX rows=$XLSX_ROWS sheet=${SHEET:0:600}"
fi

# 14. The page URL of the text answers: the page shell and the page's API for that change-set.
SHELL_CODE="$(AIOPS_PAGE_COOKIE="$ALICE" node -e 'fetch(process.argv[1], { headers: { cookie: process.env.AIOPS_PAGE_COOKIE }, redirect: "manual" }).then((r) => console.log(r.status), () => console.log(0))' "$AIOPS_PUBLIC_URL/app/changesets/$CS_N")"
VIEW_N="$(page_api "$ALICE" changeset "$CS_N" 2>&1 || true)"
if [[ "$SHELL_CODE" == 200 && "$(json "$VIEW_N" '.status')" == 200 && "$(json "$VIEW_N" '.body.id')" == "$CS_N" ]]; then
  pass page-url-answers "GET $AIOPS_PUBLIC_URL/app/changesets/$CS_N → $SHELL_CODE; page_api changeset → 200 id $CS_N"
else
  fail page-url-answers "shell=$SHELL_CODE view=${VIEW_N:0:600}"
fi

# 15. A policy denial names no change-set and gets no link.
DENY="$(alice_mcp catalog.update_content "$(cs_args "INITECH-001" "$(stamp no-link-without-changeset)" initech)")"
if [[ "$(json "$DENY" '.isError')" == true && "$DENY" != *"/app/changesets/"* && -z "$(json "$DENY" '.structuredContent?.pageUrl')" ]]; then
  pass no-link-without-changeset "brand initech → isError, no page link, no pageUrl — $(json "$DENY" '.text')"
else
  fail no-link-without-changeset "${DENY:0:1000}"
fi

# ---- Group 2: the reference MCP Apps host in headless Chromium (MCP-5, UI-6) --------------------

# 16. The host page builds from this checkout.
if pnpm --dir "$REPO" --filter @aiops/tooling build:widget-host >"$WORK/host-build.log" 2>&1; then
  pass host-build "pnpm --filter @aiops/tooling build:widget-host → $(grep -o 'dist/index.html.*' "$WORK/host-build.log" | tail -1)"
else
  fail host-build "$(tail -20 "$WORK/host-build.log")"
fi

# 17. Tool linkage and the resources as alice's host lists them.
LIST="$(host alice list)"
LINKS_CHECK="$(node -e '
  const o = JSON.parse(process.argv[1]);
  const uri = (n) => { const m = o.tools.find((t) => t.name === n)?.meta ?? {}; return [m.ui?.resourceUri ?? null, m["ui/resourceUri"] ?? null]; };
  const linked = ["catalog.update_content", "get_changeset", "submit_for_approval", "exclude_changeset_items"]
    .every((n) => uri(n).every((u) => u === "ui://aiops/changeset.html"));
  const search = uri("catalog.search_products");
  const res = ["ui://aiops/changeset.html", "ui://aiops/approval.html"].map((u) => o.resources.find((r) => r.uri === u));
  const resOk = res.every((r) => r && r.mimeType === "text/html;profile=mcp-app" && JSON.stringify(r.meta?.ui?.csp) === "{}");
  console.log(JSON.stringify({ linked, searchLinksNothing: search[0] === null && search[1] === null && o.tools.some((t) => t.name === "catalog.search_products"), resources: resOk }));' "$LIST" 2>/dev/null || echo '{}')"
if [[ "$LINKS_CHECK" == '{"linked":true,"searchLinksNothing":true,"resources":true}' ]]; then
  pass host-tool-links-resource "$LINKS_CHECK"
else
  fail host-tool-links-resource "check=$LINKS_CHECK list=${LIST:0:1500}"
fi

# 18. The preview widget: rows, exclusion of one row, submission (UI-3, CS-5).
SKUS_H="UMBRELLA-0311,UMBRELLA-0312,UMBRELLA-0313,UMBRELLA-0314"
STAMP_H="$(stamp host-preview-exclude-submit)"
RENDER_H="$(host alice render --tool catalog.update_content --args "$(cs_args "$SKUS_H" "$STAMP_H")" --exclude 1 --submit)"
H_CHECK="$(node -e '
  const o = JSON.parse(process.argv[1]);
  const ex = o.calls.find((c) => c.name === "exclude_changeset_items");
  const sub = o.calls.find((c) => c.name === "submit_for_approval");
  console.log(JSON.stringify({ state: o.state, rows: o.rows, triggerHash: ex?.args?.hash ?? null, excludeHash: ex?.structuredContent?.changeset?.hash ?? null,
    submitted: sub?.args?.changeset_id ?? null, submitStatus: sub?.structuredContent?.status ?? null, errors: o.errors }));' "$RENDER_H" 2>/dev/null || echo '{}')"
CS_H="$(json "$H_CHECK" '.submitted')"
if [[ "$(json "$H_CHECK" '.state')" == initialized && "$(json "$H_CHECK" '.rows')" -ge 4 && -n "$(json "$H_CHECK" '.excludeHash')" &&
  "$(json "$H_CHECK" '.excludeHash')" != "$(json "$H_CHECK" '.triggerHash')" && "$(json "$H_CHECK" '.submitStatus')" == pending_approval ]]; then
  pass host-preview-exclude-submit "$H_CHECK; buttons $(json "$RENDER_H" '.buttons')"
else
  fail host-preview-exclude-submit "check=$H_CHECK render=${RENDER_H:0:2000}"
fi

# 19. The same run: the widget's own fetch is blocked by the host's CSP (UI-6).
if [[ "$(json "$RENDER_H" '.cspBlocked')" == true ]]; then
  pass host-csp-blocks-fetch "fetch from the widget frame failed with a connect-src violation"
else
  fail host-csp-blocks-fetch "cspBlocked=$(json "$RENDER_H" '.cspBlocked')"
fi

# 20. The same run: the host's theme variables reach the widget.
if [[ "$(json "$RENDER_H" '.themeVar')" == "rgb(1, 2, 3)" ]]; then
  pass host-theme-applied "--color-background-primary = $(json "$RENDER_H" '.themeVar')"
else
  fail host-theme-applied "themeVar=$(json "$RENDER_H" '.themeVar')"
fi

# 21. dave approves the widget's change-set on the page; the result widget shows the counts.
page_approve "${CS_H:-none}"
RENDER_R="$(host alice render --tool get_changeset --args "{\"changeset_id\":\"${CS_H:-none}\"}" --wait-terminal 240)"
R_STATUS="$(node -e '
  const o = JSON.parse(process.argv[1]);
  const last = [...o.calls].reverse().find((c) => c.name === "get_changeset");
  console.log(last?.structuredContent?.changeset?.status ?? "");' "$RENDER_R" 2>/dev/null || true)"
# The trigger itself may already be terminal (then the widget polls nothing).
[[ -n "$R_STATUS" ]] || R_STATUS="$(json "$(alice_mcp get_changeset "{\"changeset_id\":\"${CS_H:-none}\",\"page_size\":1}")" '.structuredContent.changeset.status')"
R_BODY="$(json "$RENDER_R" '.bodyText')"
if [[ "$(json "$APPROVE" '.status')" == 200 && "$R_STATUS" == completed && "$R_BODY" == *3* && "${R_BODY,,}" == *written* ]]; then
  pass host-result-counts "dave approved $CS_H ($APPROVE_COUNT); widget status $R_STATUS; body: $(tr '\n' ' ' <<<"${R_BODY:0:400}")"
else
  fail host-result-counts "decide=$APPROVE status=$R_STATUS render=${RENDER_R:0:2000}"
fi

# 22. The approval widget with allow_widget false: no approve button, the page link opens (APR-8).
SKUS_D="UMBRELLA-0321,UMBRELLA-0322,UMBRELLA-0323"
prepare "$(cs_args "$SKUS_D" "$(stamp host-approval-default)")" 120
CS_D="$PREP_ID"
SUB_D="$(submit "$CS_D" "$PREP_HASH")"
RENDER_D="$(host dave render --tool review_changeset --args "{\"changeset_id\":\"${CS_D:-none}\"}" --open-page)"
D_CHECK="$(node -e '
  const o = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ approveButton: o.buttons.some((b) => /^Approve/.test(b)), links: o.links, errors: o.errors }));' "$RENDER_D" 2>/dev/null || echo '{}')"
if [[ "$(json "$SUB_D" '.structuredContent.status')" == pending_approval && "$(json "$D_CHECK" '.approveButton')" == false &&
  "$(json "$D_CHECK" '.links')" == "[\"$AIOPS_PUBLIC_URL/app/changesets/$CS_D\"]" ]]; then
  pass host-approval-default "dave: review_changeset $CS_D (pending) → $D_CHECK; buttons $(json "$RENDER_D" '.buttons')"
else
  fail host-approval-default "submit=$(json "$SUB_D" '.structuredContent.status') check=$D_CHECK render=${RENDER_D:0:2000}"
fi

# 23. Allow widget decisions and reload; decide_changeset becomes visible to dave.
sed -i 's/allow_widget: false }/allow_widget: true }/' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml"
compose kill -s HUP api worker >/dev/null 2>&1 || true
LISTED=no
T0=$SECONDS
while ((SECONDS - T0 < 60)); do
  DAVE_TOKEN="$(login dave 2>/dev/null || true)"
  DLIST="$(node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" --token "$DAVE_TOKEN" --list 2>&1 || true)"
  if [[ "$(json "$DLIST" '.tools.includes("decide_changeset")')" == true ]]; then LISTED=yes; break; fi
  sleep 2
done
if grep -q 'allow_widget: true }' "$AIOPS_ACCEPT_CONFIG_DIR/roles.yaml" && [[ "$LISTED" == yes ]]; then
  pass reconfigure-allow-widget "allow_widget: true, SIGHUP api worker; dave lists decide_changeset after $((SECONDS - T0)) s"
else
  fail reconfigure-allow-widget "listed=$LISTED tools=${DLIST:0:800}"
fi

# 24. The approval widget decides; the decision is audited on the widget channel (APR-8).
SKUS_W="UMBRELLA-0331,UMBRELLA-0332,UMBRELLA-0333"
STAMP_W="$(stamp host-approval-widget-decides)"
prepare "$(cs_args "$SKUS_W" "$STAMP_W")" 120
CS_W="$PREP_ID"
SUB_W="$(submit "$CS_W" "$PREP_HASH")"
RENDER_W="$(host dave render --tool review_changeset --args "{\"changeset_id\":\"${CS_W:-none}\"}" --decide approve)"
W_CHECK="$(node -e '
  const o = JSON.parse(process.argv[1]);
  const d = o.calls.find((c) => c.name === "decide_changeset");
  console.log(JSON.stringify({ decided: d !== undefined, isError: d?.isError ?? null, status: d?.structuredContent?.status ?? null, errors: o.errors }));' "$RENDER_W" 2>/dev/null || echo '{}')"
W_AUDIT="$(psql_q "select count(*) from audit_event where action = 'approval.decision' and outcome = 'ok' and changeset_id = '${CS_W:-00000000-0000-0000-0000-000000000000}' and details->>'channel' = 'widget'" 2>&1 || true)"
poll_cs "${CS_W:-none}" "$TERMINAL" 300 || true
if [[ "$(json "$SUB_W" '.structuredContent.status')" == pending_approval && "$(json "$W_CHECK" '.decided')" == true && "$(json "$W_CHECK" '.isError')" == false &&
  "$(json "$W_CHECK" '.status')" =~ ^(approved|executing)$ && "$W_AUDIT" == 1 && "$POLL_STATUS" == completed ]]; then
  pass host-approval-widget-decides "dave: widget approve $CS_W → $W_CHECK; ok approval.decision audit events (widget): $W_AUDIT; then $POLL_STATUS; sandbox $(sandbox_descriptions "$SKUS_W")"
else
  fail host-approval-widget-decides "submit=$(json "$SUB_W" '.structuredContent.status') check=$W_CHECK audit=$W_AUDIT status=$POLL_STATUS render=${RENDER_W:0:2000}"
fi

cat <<'MANUAL'
# MANUAL CHECKS (criteria 1 and 2; not automatable here)
# 1. Start the stack for HTTPS clients:
#    - Open two HTTPS tunnels of your choice, for example `cloudflared tunnel --url http://localhost:8400` (api)
#      and `cloudflared tunnel --url http://localhost:8480` (Keycloak). Note the hosts <api-host> and <kc-host>.
#    - Start the stack: `AIOPS_PUBLIC_URL=https://<api-host> AIOPS_MCP_RESOURCE=https://<api-host>/mcp AIOPS_KEYCLOAK_PUBLIC_URL=https://<kc-host> API_ALLOWED_HOSTS=localhost,127.0.0.1,<api-host> docker compose up -d --build --wait`.
#    - Store the Magento token as carol on `https://<api-host>/app/credentials`.
#    - Check that `curl -s https://<api-host>/readyz` answers ok.
# 2. Claude Desktop:
#    - Add the connector: claude.ai → Customize → Connectors → add custom connector `aiops`, URL `https://<api-host>/mcp`.
#      Log in as `alice` / `dev-only-password` (CIMD, as in manual check M1).
#    - In Claude Desktop, start a new chat, enable the connector and ask: "Update the description of UMBRELLA-0401,
#      UMBRELLA-0402, UMBRELLA-0403 and UMBRELLA-0404 to 'Manual check Claude <date>'".
#    - Expect the preview widget with 4 rows. Tick one row and choose "Exclude selected (1)": expect a new change-set
#      notice. Choose "Submit 3 changes": expect a waiting notice with the page link.
#    - Open `https://<api-host>/app/approvals` as `dave`, approve, then ask Claude for the status: expect the result
#      widget with 3 written.
#    - Toggle light and dark mode: the widget follows.
# 3. ChatGPT:
#    - Add the custom MCP server `aiops` at `https://<api-host>/mcp` with OAuth through the pre-registered client
#      `aiops-mcp` (as in manual check M1).
#    - Run the same flow with UMBRELLA-0411..0414 and expect the same results.
# 4. Record pass or fail per client, with the date, client version and what was observed, in PROGRESS.md
#    "Blockers and manual checks" under Phase 7.
# 5. Stop the tunnels and `docker compose down`.
MANUAL

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS (automated checks)"; else echo "# RESULT: FAIL"; fi
exit "$FAILED"
