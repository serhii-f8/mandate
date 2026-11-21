#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
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
#   of the api or the worker;
#   group 2, an opaque MCP write approved and executed once (CS-1, CS-5, APR-5, APR-6, EXE-4, EXE-8,
#   POL-5, SEC-3): op-prepare, op-exclude-refused, op-raw-args, op-approved, op-executed-once,
#   op-rollback-refused, op-audit. It binds the fake's `create_note` as the `write_opaque` operation
#   notes.create_note with its live pin and grants it to content_manager (whose role rule needs one
#   content_lead step). alice's call prepares one item and sends nothing; exclusion is refused; alice
#   submits (plan reason `opaque`) and dave, now the approver, sees the raw arguments on the page and
#   approves there, and the change-set runs; the fake received exactly one tools/call of create_note; rollback is
#   refused; the audit has the transitions and the batch and never the argument text. It runs alone
#   or after group 1 (it attaches the connections itself when group 1 did not).
#   group 3, the Gitea preset from its tarball with no core change (CONN-8, OPS-5, OPS-6, POL-2,
#   NFR-17): gitea-config-apply, gitea-credential, gitea-scope-allowed, gitea-scope-denied, gl-prepare,
#   gl-approved-executed, gl-rolled-back, gl-unknown-label, no-core-change. It adds `gitea.yaml`
#   (preset gitea-issues bound to connection gitea, role issue_manager for group content with one
#   content_lead step, gitea_admin for admins); `config diff` names the preset and `config apply` loads
#   it live; carol enters the bare write:issue token on the credential page and the connection test
#   passes; alice's issue search inside acme/website returns the open bug issues and the same search on
#   acme/internal is denied with its audited rule; alice sets [bug, wontfix] on issues 1-5, dave
#   approves on the page, Gitea has the labels, alice rolls back on the page and Gitea has the seeded
#   labels again; an unknown label name on issue 6 ends the item `failed` and Gitea keeps [bug]
#   (OPS-5); the history of the checkout shows that no commit touching presets/gitea-issues and no
#   commit of the plan (trailer `Plan: phase-9-mcp-upstream-gitea`) changes packages/core, apps/api or
#   apps/worker. Runs alone or after groups 1 and 2.
#   group 4, a service account writes only through human approval (AUTH-4, APR-1, POL-8, AUD-2,
#   CFG-3, POL-7): sa-config, sa-token, sa-tools, sa-denied, sa-approved-write, sa-no-secret. It needs
#   group 2 on the same stack: notes.create_note is bound by group 2's own apply. It adds
#   `service-accounts.yaml` (role integration, notes.create_note only, always one content_lead step;
#   service account aiops-sa-ci, the client the bundled Keycloak bootstrap creates); `config apply`
#   shows `+ service_account aiops-sa-ci` and `config explain --service` allows the operation; the
#   client-credentials token has azp aiops-sa-ci and no sid; it lists notes.create_note and neither
#   everything.echo nor review_changeset nor decide_changeset; everything.echo is not found and the
#   deny is audited for service:aiops-sa-ci; its note change-set (requester service:aiops-sa-ci) is
#   submitted, approved by dave on the page, completes, and the fake receives exactly one more call;
#   the api, worker and keycloak-setup logs hold neither the token nor the client secret.
# `--history-only` runs only no-core-change (git history, no Docker) and prints `# RESULT`.
# Setup before the groups: sandbox-gitea-ready (deploy/sandbox/gitea up, seeded, a write:issue token
# in GTOKEN), presets-packed (every preset of the built image is packed with `npm pack` and extracted
# into a node_modules tree that the api and the worker mount as their only preset directory, so every
# group loads presets from tarballs, CONN-8), stack-healthy, presets-dir-env.
# AIOPS_ACCEPT9_GROUPS selects the groups (default "1 2 3 4"); a selected group that is not defined is a
# FAIL (ADR 0043).
# Tests the committed HEAD (a fresh clone sees only commits), with a Compose override that mounts a
# generated configuration and the packed presets, joins the api and the worker to the sandbox network
# `aiops-sandbox` and adds the two MCP containers. No Magento sandbox; the Gitea sandbox (port
# AIOPS_GITEA_PORT, default 4391) is brought up and seeded idempotently.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`; exits non-zero if any fails.
# Not part of CI: pulls node:24-bookworm-slim and fetches the everything server with npx.
# Secrets: access tokens, the Gitea tokens and session cookies travel through variables, stdin and the
# environment of node only, never argv; they are never printed or written to a file.
# Needs: docker with compose v2, git, node, curl, and `pnpm install` in this checkout.
# The functions run through the trap and the group dispatch, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
FAILED=0

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }

# ---- Check 9 of group 3: the Gitea preset needed no change to core, api or worker (CONN-8) -------
# Reads only git history of $REPO at $SHA; no Docker. Merge commits are skipped on purpose: a merge's
# first-parent diff would show other plans' work. The plan's commits carry the trailer
# `Plan: phase-9-mcp-upstream-gitea`; its range is BASE (parent of the first) .. END (the last).
PLAN_TRAILER='Plan: phase-9-mcp-upstream-gitea'
check_no_core_change() {
  local commits c touched bad="" plan first base end ledger ledger_base base_detail range n_range foreign
  commits="$(git -C "$REPO" log --no-merges --format=%H "$SHA" -- presets/gitea-issues)" ||
    { fail no-core-change "git log over presets/gitea-issues failed"; return 0; }
  [[ -n "$commits" ]] || { fail no-core-change "no commit touches presets/gitea-issues at ${SHA:0:12}"; return 0; }
  # a. No commit that touches the preset touches core, api or worker.
  for c in $commits; do
    touched="$(git -C "$REPO" diff-tree --no-commit-id --name-only -r "$c" | grep -E '^(packages/core|apps/api|apps/worker)/' || true)"
    [[ -z "$touched" ]] || bad+="${c:0:12} ($(git -C "$REPO" log -1 --format=%s "$c")) touches $(tr '\n' ' ' <<<"$touched"); "
  done
  [[ -z "$bad" ]] || { fail no-core-change "$bad"; return 0; }
  # b. The plan's range from its trailer.
  plan="$(git -C "$REPO" log --no-merges --reverse --format=%H --grep="^${PLAN_TRAILER}\$" "$SHA")"
  [[ -n "$plan" ]] || { fail no-core-change "no commit carries the trailer '$PLAN_TRAILER'"; return 0; }
  first="$(head -1 <<<"$plan")"
  end="$(tail -1 <<<"$plan")"
  base="$(git -C "$REPO" rev-parse --verify --quiet "${first}^")" || { fail no-core-change "the first plan commit ${first:0:12} has no parent"; return 0; }
  # c. The controller's ledger, when present, names the same base.
  ledger="$REPO/.superpowers/sdd/phase-9-mcp-upstream-gitea/progress.md"
  if [[ -f "$ledger" ]]; then
    ledger_base="$(sed -n 's/^Task 1: dispatched (base \([0-9a-f]\{7,40\}\))$/\1/p' "$ledger" | head -1)"
    [[ -n "$ledger_base" ]] || { fail no-core-change "the ledger has no line 'Task 1: dispatched (base <sha>)'"; return 0; }
    if [[ "$(git -C "$REPO" rev-parse --verify --quiet "${ledger_base}^{commit}" || true)" != "$base" ]]; then
      fail no-core-change "the ledger base $ledger_base is not the parent ${base:0:12} of the first plan commit ${first:0:12}"; return 0
    fi
    base_detail="ledger base ${ledger_base:0:12} matches"
  else
    base_detail="ledger absent; range from trailers"
  fi
  # d. Every commit of the range is a plan commit; a foreign commit would void the claim.
  range="$(git -C "$REPO" log --no-merges --format=%H "$base..$end")"
  n_range="$(grep -c . <<<"$range" || true)"
  foreign=""
  for c in $range; do
    grep -qx "$PLAN_TRAILER" <<<"$(git -C "$REPO" log -1 --format=%B "$c")" || foreign+="${c:0:12} ($(git -C "$REPO" log -1 --format=%s "$c")); "
  done
  [[ -z "$foreign" ]] || { fail no-core-change "commits in ${base:0:12}..${end:0:12} without the trailer: $foreign"; return 0; }
  # e. The range changes nothing under core, api or worker.
  touched="$(git -C "$REPO" diff --stat "$base..$end" -- packages/core apps/api apps/worker)"
  [[ -z "$touched" ]] || { fail no-core-change "diff ${base:0:12}..${end:0:12} over core/api/worker: $(tr '\n' '|' <<<"$touched")"; return 0; }
  pass no-core-change "$(grep -c . <<<"$commits" || true) commits touch presets/gitea-issues; range ${base:0:12}..${end:0:12} ($n_range commits, all Plan-trailed); $base_detail; diff over core/api/worker empty"
}

result() {
  if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
  exit "$FAILED"
}

# --history-only: check 9 alone, before any port, clone or compose call.
if [[ "${1:-}" == --history-only ]]; then
  echo "# Phase 9 history check of ${SHA:0:12}"
  check_no_core_change
  result
fi
(($# == 0)) || { echo "usage: $0 [--history-only]" >&2; exit 2; }

WORK="$(mktemp -d)"
PROJECT="aiops-accept9-$$"

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
AIOPS_API_PORT="$(free_port)" AIOPS_KEYCLOAK_PORT="$(free_port)" AIOPS_TEMPORAL_PORT="$(free_port)" AIOPS_POSTGRES_PORT="$(free_port)"
AIOPS_MAILPIT_PORT="$(free_port)" AIOPS_FAKE_MCP_PORT="$(free_port)"
export AIOPS_API_PORT AIOPS_KEYCLOAK_PORT AIOPS_TEMPORAL_PORT AIOPS_POSTGRES_PORT AIOPS_MAILPIT_PORT AIOPS_FAKE_MCP_PORT
export AIOPS_KEYCLOAK_PUBLIC_URL="http://localhost:${AIOPS_KEYCLOAK_PORT}"
export AIOPS_MCP_RESOURCE="http://localhost:${AIOPS_API_PORT}/mcp"
export AIOPS_PUBLIC_URL="http://localhost:${AIOPS_API_PORT}"
# The admin password service-token.mjs reads the service account's client secret with (group 4).
export KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-dev-only-keycloak-admin-password}"
export AIOPS_ACCEPT_CONFIG_DIR="$WORK/config"
# The packed presets (presets-packed); the overlay requires it for every compose call, the cleanup's
# `compose down` included.
export AIOPS_ACCEPT_PRESET_DIR="$WORK/presets"
GITEA="http://127.0.0.1:${AIOPS_GITEA_PORT:-4391}"
MCP="http://127.0.0.1:${AIOPS_API_PORT}/mcp"
API="$AIOPS_PUBLIC_URL"
FAKE="http://127.0.0.1:${AIOPS_FAKE_MCP_PORT}"

compose() { docker compose -p "$PROJECT" -f compose.yaml -f scripts/acceptance/phase-9.compose.yaml "$@"; }

cleanup() {
  (cd "$WORK/aiops" 2>/dev/null && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

json() { node -e "try{const v=JSON.parse(process.argv[1])$2;console.log(v===undefined?'':typeof v==='string'?v:JSON.stringify(v))}catch{console.log('')}" "$1"; }
login() { node "$REPO/tooling/acceptance/login.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$1" dev-only-password "$AIOPS_MCP_RESOURCE"; }
page_login() { node "$REPO/tooling/acceptance/page-login.mjs" "$API" "$1" dev-only-password "${2:-/app/approvals}"; }
page_api() { AIOPS_PAGE_COOKIE="$1" node "$REPO/tooling/acceptance/page-api.mjs" "$API" "${@:2}"; }
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
# Polls the count query every 2 s for at most 30 s until it reaches MIN; prints the last count. The
# pin monitor audits a transition on its next evaluation (about a second after the state changes),
# so a client can see the new state before its upstream.pin row exists.
await_count() {
  local deadline=$((SECONDS + 30)) n
  while :; do
    n="$(psql_q "$1" 2>&1 || true)"
    [[ "$n" =~ ^[0-9]+$ ]] && ((n >= $2)) && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  echo "$n"
}
started_at() { docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q "$1")"; }
cli() { compose exec -T api node dist/cli.js "$@"; }
apply_config() { cli config apply /etc/aiops/config --actor acceptance 2>&1; }
# The hash of the tool in `mcp tools` output (`<tool> <hash> <operation|-> <state|unreferenced>`).
hash_of() { sed -n "s/^$2 \(sha256:[0-9a-f]\{64\}\) .*$/\1/p" <<<"$1" | head -1; }

# Enters the Gitea token (GTOKEN, on stdin) as the credential gitea-integration with the page session
# COOKIE of a user who may manage it; prints page-api's {"status":n}. The preset authenticates with
# `Authorization: Bearer <token>`, so the credential is the bare token.
put_gitea_credential() { page_api "$1" put-credential gitea-integration <<<"$GTOKEN"; }

# The Gitea configuration of group 3, written to FILE (applied there, not at start).
write_gitea_config() {
  cat >"$1" <<'YAML'
version: 1
presets:
  - { id: gitea-issues, package: '@aiops/gitea-issues', version: '^1.0.0' }
connections:
  - id: gitea
    adapter: openapi
    base_url: http://gitea-sandbox:3000/api/v1
    credential_ref: gitea-integration
    preset: gitea-issues
    allow_private_network: true
    test: { operation: issues.search, args: { owner: acme, repo: website, fields: [number], limit: 1 } }
roles:
  - id: issue_manager
    grants:
      - { operation: issues.search, id: website-issues, scope: { owner: [acme], repo: [website] } }
      - { operation: issues.get_many, id: website-get, scope: { owner: [acme], repo: [website] } }
      - { operation: issues.set_labels, id: website-labels, scope: { owner: [acme], repo: [website] } }
    approval: { required: always, steps: [{ role: content_lead }], allow_widget: false }
  - { id: gitea_admin, grants: [], manage_credentials: [gitea-integration] }
role_mapping:
  - { group: content, roles: [issue_manager] }
  - { group: admins, roles: [gitea_admin] }
YAML
}

# The labels of acme/website issues NUMS (space-separated), read from the sandbox with GTOKEN, as
# {"<n>": [names sorted by code point]}; {"error": ...} when a read fails.
# shellcheck disable=SC2086
gitea_labels() {
  GITEA_TOKEN="$GTOKEN" node -e '
    const [base, ...nums] = process.argv.slice(1);
    (async () => {
      const out = {};
      for (const n of nums) {
        const res = await fetch(`${base}/api/v1/repos/acme/website/issues/${n}`, { headers: { authorization: `Bearer ${process.env.GITEA_TOKEN}` } });
        if (!res.ok) throw new Error(`issue ${n}: HTTP ${res.status}`);
        const issue = await res.json();
        out[n] = issue.labels.map((l) => l.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      }
      console.log(JSON.stringify(out));
    })().catch((e) => console.log(JSON.stringify({ error: String(e.message ?? e) })));
  ' "$GITEA" $1 # word splitting on purpose: one argument per issue number
}

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

# mcp.yaml: both connections; with pins ($1 echo, $2 get-tiny-image, $3 lookup) also the operations,
# and with a fourth pin ($4 create_note) also the opaque operation notes.create_note.
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
  (($# >= 4)) || return 0
  cat >>"$AIOPS_ACCEPT_CONFIG_DIR/mcp.yaml" <<YAML
  - id: notes.create_note
    connection: fakemcp
    risk: write_opaque
    description: Create a note.
    upstream: { tool: create_note, pin: '$4' }
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

# The Gitea sandbox is up (idempotent; it creates the network aiops-sandbox the overlay joins) and
# seeded (idempotent) with a seeding-scope token; GTOKEN is a write:issue token, the credential of
# group 3. Neither token is printed.
if bash "$REPO/deploy/sandbox/gitea/up.sh" >"$WORK/gitea.log" 2>&1 &&
  SEED_TOKEN="$(bash "$REPO/deploy/sandbox/gitea/token.sh" write:organization,write:repository,write:issue 2>>"$WORK/gitea.log")" &&
  GITEA_SANDBOX_TOKEN="$SEED_TOKEN" node "$REPO/deploy/sandbox/gitea/seed.mjs" "$GITEA" >>"$WORK/gitea.log" 2>&1 &&
  GTOKEN="$(bash "$REPO/deploy/sandbox/gitea/token.sh" write:issue 2>>"$WORK/gitea.log")" && [[ "$GTOKEN" =~ ^[0-9a-f]{40}$ ]]; then
  unset SEED_TOKEN
  if docker network inspect aiops-sandbox >/dev/null 2>&1; then
    pass sandbox-gitea-ready "$(grep -o 'GITEA UP.*' "$WORK/gitea.log" | tail -1); $(grep -o 'SEEDED gitea.*' "$WORK/gitea.log" | tail -1); write:issue token present; network aiops-sandbox present"
  else
    fail sandbox-gitea-ready "network aiops-sandbox missing"; exit 1
  fi
else
  fail sandbox-gitea-ready "see sandbox output below"; tail -30 "$WORK/gitea.log"; exit 1
fi

# Every preset of the built image, packed with `npm pack` and extracted into the node_modules tree
# that the api and the worker mount as their only preset directory (CONN-8).
pack_presets() {
  local dir tgz name
  mkdir -p "$WORK/image-presets" "$WORK/tarballs" "$AIOPS_ACCEPT_PRESET_DIR/node_modules"
  compose build api >"$WORK/build.log" 2>&1 || { echo "compose build api failed:"; tail -30 "$WORK/build.log"; return 1; }
  compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$WORK/image-presets:/out" --entrypoint sh api \
    -c 'cp -R /app/presets/. /out/' >>"$WORK/build.log" 2>&1 || { echo "copy of /app/presets failed:"; tail -30 "$WORK/build.log"; return 1; }
  for dir in "$WORK"/image-presets/*/; do
    npm pack --ignore-scripts --pack-destination "$WORK/tarballs" "$dir" >>"$WORK/build.log" 2>&1 ||
      { echo "npm pack $dir failed:"; tail -30 "$WORK/build.log"; return 1; }
  done
  for tgz in "$WORK"/tarballs/*.tgz; do
    name="$(tar -xzOf "$tgz" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).name))')"
    # A name segment of `.` or `..` would extract outside node_modules/<name>.
    if [[ ! "$name" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ || "/$name/" == */./* || "/$name/" == */../* ]]; then
      echo "unexpected package name in $tgz: $name"; return 1
    fi
    mkdir -p "$AIOPS_ACCEPT_PRESET_DIR/node_modules/$name"
    tar -xzf "$tgz" -C "$AIOPS_ACCEPT_PRESET_DIR/node_modules/$name" --strip-components=1 ||
      { echo "tar -xzf $tgz failed"; return 1; }
  done
}
if pack_out="$(pack_presets 2>&1)"; then
  nm="$AIOPS_ACCEPT_PRESET_DIR/node_modules"
  gitea_sdk="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).aiops?.sdk??"")}catch{console.log("")}' "$nm/@aiops/gitea-issues/package.json")"
  if [[ -f "$nm/@aiops/gitea-issues/dist/index.js" && -f "$nm/@aiops/gitea-issues/preset.yaml" &&
    -f "$nm/@aiops/gitea-issues/spec/gitea.swagger.json" && -n "$gitea_sdk" && -f "$nm/@aiops/magento2-catalog/package.json" ]]; then
    pass presets-packed "tarballs $(cd "$WORK/tarballs" && ls -- *.tgz | xargs); @aiops/gitea-issues has dist/index.js, preset.yaml, spec/gitea.swagger.json, aiops.sdk $gitea_sdk; @aiops/magento2-catalog present"
  else
    fail presets-packed "tarballs: $(cd "$WORK/tarballs" 2>/dev/null && ls -- *.tgz 2>/dev/null | xargs); extracted: $(cd "$nm" 2>/dev/null && find . -maxdepth 3 | sort | tr '\n' ' ' | head -c 1500)"; exit 1
  fi
else
  fail presets-packed "$(tr '\n' '|' <<<"$pack_out" | head -c 2000)"; exit 1
fi

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

# The api and the worker read presets only from the mounted tarball tree.
want_dirs=/etc/aiops/presets/node_modules
api_dirs="$(compose exec -T api printenv AIOPS_PRESET_DIRS 2>&1 || true)"
worker_dirs="$(compose exec -T worker printenv AIOPS_PRESET_DIRS 2>&1 || true)"
if [[ "$api_dirs" == "$want_dirs" && "$worker_dirs" == "$want_dirs" ]]; then
  pass presets-dir-env "api and worker AIOPS_PRESET_DIRS=$want_dirs"
else
  fail presets-dir-env "api: '${api_dirs:0:200}'; worker: '${worker_dirs:0:200}'; want $want_dirs"
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
      pass mcp-enable-grants "config apply → exit 0; bob lists everything.echo, alice does not; bob's call → $(json "$echo_answer" '.structuredContent.value'); alice's call → $(grep -o 'Tool everything.echo not found' <<<"$alice_echo" | head -1)"
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
    audit_pin="$(await_count "select count(*) from audit_event where action = 'upstream.pin' and subject = 'fakemcp.lookup' and details->>'to' = 'changed'" 1)"
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
    repin_pin="$(await_count "select count(*) from audit_event where action = 'upstream.pin' and subject = 'fakemcp.lookup' and details->>'from' = 'changed' and details->>'to' = 'ok'" 1)"
    if [[ "$(json "$lookup_answer" '.isError')" == false && -n "$(json "$lookup_answer" '.structuredContent')" && "$repin_pin" == 1 &&
      "$(started_at api)" == "$started_api" && "$(started_at worker)" == "$started_worker" ]]; then
      pass mcp-repin "mcp tools fakemcp: lookup $new_pin fakemcp.lookup changed; apply → exit 0; alice's call → $(json "$lookup_answer" '.structuredContent' | head -c 300); upstream.pin changed→ok: $repin_pin; api started $started_api and worker started $started_worker unchanged"
    else
      fail mcp-repin "call: ${lookup_answer:0:400}; upstream.pin changed→ok: $repin_pin (rows: $(psql_q "select ts, subject, details::text from audit_event where action = 'upstream.pin' order by ts" 2>&1 | tr '\n' '|' || true)); api $started_api → $(started_at api); worker $started_worker → $(started_at worker)"
    fi
  else
    fail mcp-repin "apply exit $apply_code: $(tr '\n' '|' <<<"$apply"); alice lists fakemcp.lookup: $(lists alice fakemcp.lookup)"
  fi
}

# ---- Group 2: an opaque MCP write approved and executed once (EXE-4, APR-5, APR-6, CS-5, EXE-8) --

# How many tools/call of the tool ($1) the fake MCP server received (its control route's log).
fake_calls() {
  local log
  log="$(curl -sf "$FAKE/_control/requests" 2>/dev/null || echo null)"
  node -e 'try{const l=JSON.parse(process.argv[1]);if(!Array.isArray(l))throw 0;console.log(l.filter((r)=>r.rpcMethod==="tools/call"&&r.tool===process.argv[2]).length)}catch{console.log("unreadable")}' "$log" "$1"
}
# get_changeset as alice every 2 s until the status matches the regex or the timeout (s) passes; the
# last answer is left in POLL and its status in POLL_STATUS. Returns 1 on timeout. An optional fourth
# argument is the page_size of the items.
poll_cs() {
  local deadline=$((SECONDS + $3))
  while :; do
    POLL="$(user_mcp alice get_changeset "{\"changeset_id\":\"$1\"${4:+,\"page_size\":$4}}")"
    POLL_STATUS="$(json "$POLL" '.structuredContent.changeset.status')"
    [[ "$POLL_STATUS" =~ $2 ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}
TERMINAL='^(completed|completed_with_errors|failed|cancelled|expired|rolled_back)$'
NOTE_TEXT="phase 9 acceptance"

group_2() {
  local apply apply_code tools fake_tools echo_pin image_pin lookup_pin note_pin prep cs hash calls dave view exclude
  local sub plan decide items rollback audit

  # 0. The connections are attached (group 1 did it when it ran); the pins are the live ones.
  if [[ ! -f "$AIOPS_ACCEPT_CONFIG_DIR/mcp.yaml" ]]; then
    write_mcp
    apply_code=0
    apply="$(apply_config)" || apply_code=$?
    [[ "$apply_code" == 0 ]] || { fail op-prepare "attach: apply exit $apply_code: $(tr '\n' '|' <<<"$apply")"; return 0; }
  fi
  tools="$(cli mcp tools everything 2>&1 || true)"
  fake_tools="$(cli mcp tools fakemcp 2>&1 || true)"
  echo_pin="$(hash_of "$tools" echo)"
  image_pin="$(hash_of "$tools" get-tiny-image)"
  lookup_pin="$(hash_of "$fake_tools" lookup)"
  note_pin="$(hash_of "$fake_tools" create_note)"
  if [[ -z "$echo_pin" || -z "$image_pin" || -z "$lookup_pin" || -z "$note_pin" ]]; then
    fail op-prepare "pins missing: mcp tools everything: $(tr '\n' '|' <<<"$tools" | head -c 800); fakemcp: $(tr '\n' '|' <<<"$fake_tools")"
    return 0
  fi
  write_mcp "$echo_pin" "$image_pin" "$lookup_pin" "$note_pin"
  write_roles "$GRANTS_SUPPORT" "$GRANTS_CONTENT
      - { operation: notes.create_note }"
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  if [[ "$apply_code" != 0 ]] || ! await_listed alice notes.create_note yes; then
    fail op-prepare "apply exit $apply_code: $(tr '\n' '|' <<<"$apply"); alice lists notes.create_note: $(lists alice notes.create_note)"
    return 0
  fi

  # 1. alice's call prepares one item and sends nothing upstream (CS-1, EXE-4).
  prep="$(user_mcp alice notes.create_note "{\"text\":\"$NOTE_TEXT\"}")"
  cs="$(json "$prep" '.structuredContent.changeset.id')"
  hash="$(json "$prep" '.structuredContent.changeset.hash')"
  calls="$(fake_calls create_note)"
  if [[ "$(json "$prep" '.structuredContent.changeset.status')" == prepared && "$(json "$prep" '.structuredContent.changeset.stats.included')" == 1 &&
    "$(json "$prep" '.structuredContent.changeset.kind')" == opaque && "$calls" == 0 ]]; then
    pass op-prepare "config apply → exit 0; alice notes.create_note → change-set $cs prepared, kind opaque, stats $(json "$prep" '.structuredContent.changeset.stats'), hash $hash; tools/call create_note at the fake: $calls"
  else
    fail op-prepare "tools/call create_note: $calls; answer: ${prep:0:1200}"
    return 0
  fi

  # 2. An opaque change-set has no items to exclude (CS-5).
  exclude="$(user_mcp alice exclude_changeset_items "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\",\"exclude\":[\"call\"]}")"
  audit="$(psql_q "select count(*) from audit_event where action = 'tool.call' and details->>'errorCode' = 'not_excludable'" 2>&1 || true)"
  if [[ "$(json "$exclude" '.isError')" == true && "$(json "$exclude" '.content[0]')" == "Change-set $cs is a single upstream call; it has no items to exclude."* && "$audit" == 1 ]]; then
    pass op-exclude-refused "exclude_changeset_items → isError: $(json "$exclude" '.content[0]'); tool.call not_excludable: $audit"
  else
    fail op-exclude-refused "tool.call not_excludable: $audit; answer: ${exclude:0:800}"
  fi

  # 3. alice submits; the plan needs approval because the call is opaque (POL-5). dave, the
  #    approver, sees the change-set from now on: his page detail states the opaque kind and the
  #    stored raw arguments (APR-5, APR-6).
  sub="$(user_mcp alice submit_for_approval "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
  plan="$(psql_q "select approval_plan->>'reason' from change_set where id = '$cs'" 2>&1 || true)"
  dave="$(page_login dave 2>&1)" || { fail op-raw-args "page login: $dave"; return 0; }
  view="$(page_api "$dave" changeset "$cs" 2>&1 || true)"
  if [[ "$(json "$view" '.status')" == 200 && "$(json "$view" '.body.kind')" == opaque && "$(json "$view" '.body.request.args.text')" == "$NOTE_TEXT" ]]; then
    pass op-raw-args "dave: changeset $cs → 200, kind $(json "$view" '.body.kind'), request.args $(json "$view" '.body.request.args')"
  else
    fail op-raw-args "submit: ${sub:0:400}; view: ${view:0:1200}"
    return 0
  fi

  # 4. dave approves on the page with the hash and count he sees; the last step starts the run.
  decide="$(page_api "$dave" decide "$cs" approve "$(json "$view" '.body.hash')" "$(json "$view" '.body.stats.included')" 2>&1 || true)"
  if [[ "$(json "$sub" '.structuredContent.status')" == pending_approval && "$plan" == opaque && "$(json "$view" '.body.hash')" == "$hash" &&
    "$(json "$decide" '.status')" == 200 ]]; then
    pass op-approved "submit → pending_approval, plan reason $plan; dave: decide approve $hash 1 → $decide"
  else
    fail op-approved "submit: ${sub:0:600}; plan reason: $plan; view hash: $(json "$view" '.body.hash'); decide: $decide"
    return 0
  fi

  # 5. The run completes, its item is written, and the fake received exactly one call (EXE-4).
  poll_cs "$cs" "$TERMINAL" 180 || true
  items="$(json "$POLL" '.structuredContent.items.map((i)=>i.targetId+":"+i.status).join(",")')"
  calls="$(fake_calls create_note)"
  if [[ "$POLL_STATUS" == completed && "$items" == "call:written" && "$calls" == 1 ]]; then
    pass op-executed-once "$cs $POLL_STATUS; items $items; tools/call create_note at the fake: $calls"
  else
    fail op-executed-once "status $POLL_STATUS; items $items; tools/call create_note: $calls; answer: ${POLL:0:800}"
    return 0
  fi

  # 6. The operation has no rollback (EXE-8, MCP-8).
  rollback="$(user_mcp alice rollback_changeset "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
  audit="$(psql_q "select count(*) from audit_event where action = 'tool.call' and details->>'errorCode' = 'not_rollbackable'" 2>&1 || true)"
  if [[ "$(json "$rollback" '.isError')" == true && "$(json "$rollback" '.structuredContent.rollback.reason')" == strategy_none && "$audit" == 1 ]]; then
    pass op-rollback-refused "rollback_changeset → isError $(json "$rollback" '.structuredContent.rollback'); tool.call not_rollbackable: $audit"
  else
    fail op-rollback-refused "tool.call not_rollbackable: $audit; answer: ${rollback:0:800}"
  fi

  # 7. Audit: the transitions to prepared, approved and completed and one batch row; no audit row
  #    carries the argument text (SEC-3).
  audit="$(psql_q "select
      (select count(*) from audit_event where action = 'changeset.transition' and changeset_id = '$cs' and details->>'to' = 'prepared')
      || ',' || (select count(*) from audit_event where action = 'changeset.transition' and changeset_id = '$cs' and details->>'to' = 'approved')
      || ',' || (select count(*) from audit_event where action = 'changeset.transition' and changeset_id = '$cs' and details->>'to' = 'completed')
      || ',' || (select count(*) from audit_event where action = 'changeset.batch' and changeset_id = '$cs')
      || ',' || (select count(*) from audit_event where details::text like '%$NOTE_TEXT%')" 2>&1 || true)"
  if [[ "$audit" == "1,1,1,1,0" ]]; then
    pass op-audit "transitions to prepared, approved, completed; changeset.batch; rows with the argument text: $audit"
  else
    fail op-audit "counts (to prepared, to approved, to completed, batch, rows with the argument text) = $audit; rows: $(psql_q "select action, details::text from audit_event where changeset_id = '$cs' order by ts" 2>&1 | tr '\n' '|' | head -c 1500 || true)"
  fi
}

# ---- Group 3: the Gitea preset from its tarball, approved, rolled back, with no core change -------
# (CONN-8, OPS-5, OPS-6, POL-2, NFR-17)

# alice's issues.set_labels call; polled while it is preparing. Leaves the answer in PREP and its
# change-set ID, hash and status in PREP_ID, PREP_HASH and PREP_STATUS.
gitea_prepare() {
  local status
  PREP="$(user_mcp alice issues.set_labels "$1")"
  PREP_ID="$(json "$PREP" '.structuredContent.changeset.id')"
  [[ -n "$PREP_ID" ]] || PREP_ID="$(json "$PREP" '.structuredContent.changesetId')"
  status="$(json "$PREP" '.structuredContent.changeset.status')"
  [[ -n "$status" ]] || status="$(json "$PREP" '.structuredContent.status')"
  if [[ "$status" == preparing && -n "$PREP_ID" ]]; then
    poll_cs "$PREP_ID" '^[^p]|^prepared$' 120 || true
    PREP="$POLL"
  fi
  PREP_HASH="$(json "$PREP" '.structuredContent.changeset.hash')"
  PREP_STATUS="$(json "$PREP" '.structuredContent.changeset.status')"
}
# dave approves a change-set on the page with the hash and count he sees there. Leaves the answer in
# APPROVE and the values he sent in APPROVE_HASH and APPROVE_COUNT.
gitea_approve() {
  local dave view
  APPROVE_HASH="" APPROVE_COUNT=""
  dave="$(page_login dave 2>&1)" || { APPROVE="{\"loginError\":true}"; return 0; }
  view="$(page_api "$dave" changeset "$1" 2>&1 || true)"
  APPROVE_HASH="$(json "$view" '.body.hash')"
  APPROVE_COUNT="$(json "$view" '.body.stats.included')"
  APPROVE="$(page_api "$dave" decide "$1" approve "${APPROVE_HASH:-x}" "${APPROVE_COUNT:-0}" 2>&1 || true)"
}
# The labels per targetId of a get_changeset answer, from the items' before ($2 = before) or after.
item_labels() { node -e 'try{const o=JSON.parse(process.argv[1]);const m={};for(const i of o.structuredContent.items)m[i.targetId]=i[process.argv[2]]?.labels??null;console.log(JSON.stringify(m))}catch{console.log("{}")}' "$1" "$2"; }
# The rollback stats of a get_changeset answer as sorted [key, value] pairs (jsonb orders keys its own way).
sorted_stats() { node -e 'try{const o=JSON.parse(process.argv[1]).structuredContent.rollback.stats;console.log(JSON.stringify(Object.keys(o).sort().map((k)=>[k,o[k]])))}catch{console.log("")}' "$1"; }

GITEA_BEFORE='{"1":["bug"],"2":["feature"],"3":["bug","triage"],"4":[],"5":["docs"]}'
GITEA_AFTER='{"1":["bug","wontfix"],"2":["bug","wontfix"],"3":["bug","wontfix"],"4":["bug","wontfix"],"5":["bug","wontfix"]}'

group_3() {
  group_3_gitea
  # 9. Independent of checks 1-8: the history shows the preset needed no core, api or worker change.
  check_no_core_change
}

group_3_gitea() {
  local started_api started_worker diff diff_code diff_preset pkg_version apply apply_code carol put conn_test search check deny cid row
  local cs hash view before after sub labels deadline rb alice2 page_rb stats restored cs8 sub8 items8 item6 labels6

  started_api="$(started_at api)"
  started_worker="$(started_at worker)"

  # 1. The preset is declared and bound in a new file; diff names it, apply loads it live (CONN-8).
  write_gitea_config "$AIOPS_ACCEPT_CONFIG_DIR/gitea.yaml"
  diff_code=0
  diff="$(cli config diff /etc/aiops/config 2>&1)" || diff_code=$?
  # `config diff` lists an added preset as `+ preset <id>` without its version (formatDiff), so the
  # version is read from the package the api loads: its only preset directory is the tarball tree.
  pkg_version="$(compose exec -T api node -e 'console.log(require(process.argv[1]).version)' /etc/aiops/presets/node_modules/@aiops/gitea-issues/package.json 2>&1 || true)"
  grep -qx '+ preset gitea-issues' <<<"$diff" && diff_preset=yes || diff_preset=no
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  if [[ "$diff_code" == 0 && "$diff_preset" == yes && "$pkg_version" == 1.0.0 && "$apply_code" == 0 ]] &&
    await_listed alice issues.search yes && await_listed alice issues.set_labels yes &&
    [[ "$(started_at api)" == "$started_api" && "$(started_at worker)" == "$started_worker" ]]; then
    pass gitea-config-apply "config diff → exit 0: $(grep -E '^\+ (preset|connection|operation) ' <<<"$diff" | tr '\n' '|' | head -c 400); api loads @aiops/gitea-issues $pkg_version; config apply → exit 0; alice lists issues.search and issues.set_labels; api started $started_api and worker started $started_worker unchanged"
  else
    fail gitea-config-apply "diff exit $diff_code: $(tr '\n' '|' <<<"$diff" | head -c 800); api's @aiops/gitea-issues version: ${pkg_version:0:200}; apply exit $apply_code: $(tr '\n' '|' <<<"$apply" | head -c 800); alice lists issues.search: $(lists alice issues.search), issues.set_labels: $(lists alice issues.set_labels); api $started_api → $(started_at api); worker $started_worker → $(started_at worker)"
    return 0
  fi

  # 2. carol enters the bare token on the credential page; the connection test passes.
  carol="$(page_login carol /app/credentials 2>&1)" || { fail gitea-credential "page login: $carol"; return 0; }
  put="$(put_gitea_credential "$carol" 2>&1 || true)"
  conn_test="$(page_api "$carol" test gitea 2>&1 || true)"
  if [[ "$put" == '{"status":204}' && "$(json "$conn_test" '.body.ok')" == true ]]; then
    pass gitea-credential "carol: put-credential gitea-integration → $put; test gitea → $(json "$conn_test" '.body')"
  else
    fail gitea-credential "put-credential: $put; test: ${conn_test:0:800}"
    return 0
  fi

  # 3. A search inside the grant's scope (POL-2): the open bug issues of acme/website, newest first.
  search="$(user_mcp alice issues.search '{"owner":"acme","repo":"website","labels":["bug"],"fields":["number","labels"]}')"
  check="$(node -e '
    try {
      const r = JSON.parse(process.argv[1]); const items = r.structuredContent?.items ?? [];
      const problems = [];
      if (r.isError) problems.push("isError");
      const numbers = items.map((i) => i.number).join(",");
      if (numbers !== "28,26,18,16,13,11,8,6,3,1") problems.push(`numbers ${numbers}`);
      if (!items.every((i) => Array.isArray(i.labels) && i.labels.every((l) => typeof l === "string") && i.labels.includes("bug"))) problems.push("labels not string arrays with bug");
      console.log(problems.length === 0 ? `ok ${numbers}` : problems.join("; "));
    } catch (e) { console.log(`unreadable: ${e.message}`); }' "$search")"
  if [[ "$check" == ok* ]]; then
    pass gitea-scope-allowed "alice issues.search acme/website labels [bug] → numbers ${check#ok }, every labels a string array with bug; summary: $(json "$search" '.content[0]')"
  else
    fail gitea-scope-allowed "$check; answer: ${search:0:1200}"
  fi

  # 4. The same search on another repository is denied, and the denial is audited with its rule (POL-2).
  deny="$(user_mcp alice issues.search '{"owner":"acme","repo":"internal","labels":["bug"],"fields":["number","labels"]}')"
  cid="$(json "$deny" '.correlationId')"
  row="$(psql_q "select decision || ' ' || (details->>'rule') from audit_event where correlation_id = '${cid:-none}' and action = 'policy.decision'" 2>&1 || true)"
  if [[ "$(json "$deny" '.isError')" == true && "$(json "$deny" '.text')" == "Denied by policy:"* && -n "$cid" &&
    "$row" == *"deny role:issue_manager/grant:website-issues/scope:repo" ]]; then
    pass gitea-scope-denied "repo internal → $(json "$deny" '.text') | audited correlation_id=$cid: $row"
  else
    fail gitea-scope-denied "answer: ${deny:0:800}; row: $row"
  fi

  # 5. Five issues prepared; the stored before and after values are the seeded and requested labels.
  gitea_prepare '{"owner":"acme","repo":"website","numbers":["1","2","3","4","5"],"changes":{"labels":["bug","wontfix"]}}'
  cs="$PREP_ID"
  hash="$PREP_HASH"
  view="$(user_mcp alice get_changeset "{\"changeset_id\":\"${cs:-none}\",\"page_size\":5}")"
  before="$(item_labels "$view" before)"
  after="$(item_labels "$view" after)"
  if [[ "$PREP_STATUS" == prepared && "$(json "$PREP" '.structuredContent.changeset.stats.included')" == 5 &&
    "$before" == "$GITEA_BEFORE" && "$after" == "$GITEA_AFTER" ]]; then
    pass gl-prepare "change-set $cs prepared, stats $(json "$PREP" '.structuredContent.changeset.stats'), hash $hash; before $before; after $after"
  else
    fail gl-prepare "status=$PREP_STATUS; before=$before; after=$after; answer=${PREP:0:1200}"
    return 0
  fi

  # 6. alice submits, dave approves on the page, the run completes and Gitea has the labels (OPS-6).
  sub="$(user_mcp alice submit_for_approval "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
  gitea_approve "$cs"
  poll_cs "$cs" "$TERMINAL" 300 5 || true
  labels="$(gitea_labels "1 2 3 4 5")"
  if [[ "$(json "$sub" '.structuredContent.status')" == pending_approval && "$APPROVE_HASH" == "$hash" && "$APPROVE_COUNT" == 5 &&
    "$(json "$APPROVE" '.status')" == 200 && "$POLL_STATUS" == completed && "$labels" == "$GITEA_AFTER" ]]; then
    pass gl-approved-executed "submit → pending_approval; dave: decide approve $APPROVE_HASH 5 → $APPROVE; then $POLL_STATUS; Gitea $labels"
  else
    fail gl-approved-executed "submit=$(json "$sub" '.structuredContent.status'); decide=$APPROVE (hash $APPROVE_HASH, count $APPROVE_COUNT); status=$POLL_STATUS; items=$(json "$POLL" '.structuredContent.items.map((i)=>i.targetId+":"+i.status).join(",")'); Gitea $labels"
    return 0
  fi

  # 7. alice rolls back on the page after a fresh login; Gitea has the before values again. The
  #    rollback window opens when the workflow finishes, so the offer is awaited (bounded).
  deadline=$((SECONDS + 60))
  while :; do
    rb="$(user_mcp alice rollback_changeset "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
    [[ "$(json "$rb" '.structuredContent.rollback.available')" == true ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  alice2="$(page_login alice "/app/changesets/$cs" 2>&1)" || { fail gl-rolled-back "page login: $alice2"; return 0; }
  page_rb="$(page_api "$alice2" rollback "$cs" "$hash" 2>&1 || true)"
  if [[ "$(json "$page_rb" '.status')" == 200 && "$(json "$page_rb" '.body')" == '{"status":"rolling_back"}' ]]; then
    poll_cs "$cs" "$TERMINAL" 300 5 || true
    stats="$(sorted_stats "$POLL")"
    restored="$(gitea_labels "1 2 3 4 5")"
    if [[ "$POLL_STATUS" == rolled_back && "$stats" == '[["failed",0],["restored",5],["skipped",0]]' && "$restored" == "$before" ]]; then
      pass gl-rolled-back "alice: fresh page login; rollback $cs $hash → $page_rb; then $POLL_STATUS, rollback stats $(json "$POLL" '.structuredContent.rollback.stats'); Gitea $restored equals the before values"
    else
      fail gl-rolled-back "status=$POLL_STATUS; rollback=$(json "$POLL" '.structuredContent.rollback'); Gitea $restored; before $before"
      return 0
    fi
  else
    fail gl-rolled-back "rollback offer: $(json "$rb" '.structuredContent.rollback'); page rollback: $page_rb"
    return 0
  fi

  # 8. An unknown label name is refused before any write: Gitea would drop it silently and report
  #    success for a partial write (OPS-5). Issue 6 keeps its seeded [bug].
  gitea_prepare '{"owner":"acme","repo":"website","numbers":["6"],"changes":{"labels":["bug","no-such-label"]}}'
  cs8="$PREP_ID"
  if [[ "$PREP_STATUS" != prepared ]]; then
    fail gl-unknown-label "status=$PREP_STATUS; answer=${PREP:0:1200}"
    return 0
  fi
  sub8="$(user_mcp alice submit_for_approval "{\"changeset_id\":\"$cs8\",\"hash\":\"$PREP_HASH\"}")"
  gitea_approve "$cs8"
  poll_cs "$cs8" "$TERMINAL" 300 5 || true
  items8="$(json "$POLL" '.structuredContent.items.map((i)=>i.targetId+":"+i.status).join(",")')"
  item6="$(json "$POLL" '.structuredContent.items.find((i)=>i.targetId==="6")?.status')"
  labels6="$(gitea_labels 6)"
  if [[ "$(json "$sub8" '.structuredContent.status')" == pending_approval && "$(json "$APPROVE" '.status')" == 200 &&
    "$POLL_STATUS" =~ ^(failed|completed_with_errors)$ && "$item6" == failed && "$labels6" == '{"6":["bug"]}' ]]; then
    pass gl-unknown-label "change-set $cs8 [bug, no-such-label] on issue 6: submit → pending_approval; dave: decide approve → $APPROVE; then $POLL_STATUS; items $items8; Gitea $labels6"
  else
    fail gl-unknown-label "submit=$(json "$sub8" '.structuredContent.status'); decide=$APPROVE; status=$POLL_STATUS; items=$items8; Gitea $labels6"
  fi
}

# ---- Group 4: a service account writes through human approval (AUTH-4, APR-1, POL-8, AUD-2, CFG-3, POL-7)

# The access token of the service-account client aiops-sa-ci (client_credentials); service-token.mjs
# reads the client secret itself, so it never reaches bash (SEC-3).
SA_CLIENT=aiops-sa-ci
sa_token() { node "$REPO/tooling/acceptance/service-token.mjs" "$AIOPS_KEYCLOAK_PUBLIC_URL" "$SA_CLIENT" "$AIOPS_MCP_RESOURCE"; }
# The service account runs mcp-call.mjs with the given flags. It has no refresh token, so it gets a
# fresh token before every call and none expires during the run.
sa_client() {
  local token
  token="$(sa_token 2>&1)" || { echo "{\"tokenError\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$token")}"; return 0; }
  AIOPS_MCP_TOKEN="$token" node "$REPO/tooling/acceptance/mcp-call.mjs" "$MCP" "$@" 2>&1 || true
}
# get_changeset as the service account (the requester) every 2 s until the status matches the regex
# or the timeout (s) passes; leaves the answer in POLL and the status in POLL_STATUS. Returns 1 on timeout.
sa_poll_cs() {
  local deadline=$((SECONDS + $3))
  while :; do
    POLL="$(sa_client --tool get_changeset --args "{\"changeset_id\":\"$1\"}")"
    POLL_STATUS="$(json "$POLL" '.structuredContent.changeset.status')"
    [[ "$POLL_STATUS" =~ $2 ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}
SA_NOTE_TEXT="phase 9 service account"

group_4() {
  local apply apply_code explain token claims list tools_ok deadline denied deny_rows calls_before calls_after prep cs hash sub requester
  local logs token_hits secret_hits

  # 1. The service account is configured with its own role: notes.create_note only, always one
  #    content_lead step (CFG-3, POL-7). notes.create_note is bound by group 2's mcp.yaml.
  if ! grep -q 'id: notes.create_note' "$AIOPS_ACCEPT_CONFIG_DIR/mcp.yaml" 2>/dev/null; then
    fail sa-config "notes.create_note is not configured: group 4 needs group 2 on the same stack"
    return 0
  fi
  cat >"$AIOPS_ACCEPT_CONFIG_DIR/service-accounts.yaml" <<YAML
version: 1
roles:
  - id: integration
    grants:
      - { operation: notes.create_note }
    approval: { required: always, steps: [{ role: content_lead }], allow_widget: false }
service_accounts:
  - { client_id: $SA_CLIENT, role: integration, description: Phase 9 acceptance }
YAML
  apply_code=0
  apply="$(apply_config)" || apply_code=$?
  explain="$(cli config explain --operation notes.create_note --service "$SA_CLIENT" --args "{\"text\":\"$SA_NOTE_TEXT\"}" 2>&1 || true)"
  if [[ "$apply_code" == 0 ]] && grep -qx "+ service_account $SA_CLIENT" <<<"$apply" && grep -qx 'effect: allow' <<<"$explain"; then
    pass sa-config "config apply → exit 0: $(grep -E '^\+ (role|service_account) ' <<<"$apply" | tr '\n' '|'); config explain --service $SA_CLIENT: $(tr '\n' '|' <<<"$explain")"
  else
    fail sa-config "apply exit $apply_code: $(tr '\n' '|' <<<"$apply" | head -c 1200); explain: $(tr '\n' '|' <<<"$explain")"
    return 0
  fi

  # 2. The client-credentials token names the client and has no session (AUTH-4).
  token="$(sa_token 2>&1)" || { fail sa-token "service-token.mjs: $token"; return 0; }
  claims="$(AIOPS_MCP_TOKEN="$token" node -e 'try{const p=JSON.parse(Buffer.from(process.env.AIOPS_MCP_TOKEN.split(".")[1],"base64url").toString());console.log(JSON.stringify({azp:p.azp,sid:"sid" in p,aud:p.aud}))}catch{console.log("{}")}')"
  if [[ "$(json "$claims" '.azp')" == "$SA_CLIENT" && "$(json "$claims" '.sid')" == false ]]; then
    pass sa-token "service-token.mjs → exit 0; payload $claims"
  else
    fail sa-token "payload $claims"
    return 0
  fi

  # 3. The service account lists its operation and neither group 1's read tool nor the approver tools.
  deadline=$((SECONDS + 60))
  while :; do
    list="$(sa_client --list)"
    tools_ok="$(node -e 'try{const t=JSON.parse(process.argv[1]).tools;console.log(t.includes("notes.create_note")&&!["everything.echo","review_changeset","decide_changeset"].some((n)=>t.includes(n)))}catch{console.log(false)}' "$list")"
    [[ "$tools_ok" == true ]] && break
    ((SECONDS >= deadline)) && break
    sleep 2
  done
  if [[ "$tools_ok" == true ]]; then
    pass sa-tools "tools/list as $SA_CLIENT: $(json "$list" '.tools')"
  else
    fail sa-tools "after 60 s: ${list:0:1200}"
    return 0
  fi

  # 4. A tool outside its role is not found, and the denial is audited under the service subject (POL-8, AUD-2).
  denied="$(sa_client --tool everything.echo --args '{"message":"service account"}')"
  deny_rows="$(psql_q "select count(*) from audit_event where action='policy.decision' and decision='deny' and actor='service:$SA_CLIENT'" 2>&1 || true)"
  if [[ "$denied" == *"Tool everything.echo not found"* && "$deny_rows" =~ ^[0-9]+$ ]] && ((deny_rows >= 1)); then
    pass sa-denied "everything.echo → $(grep -o 'Tool everything.echo not found' <<<"$denied" | head -1); policy.decision deny rows for service:$SA_CLIENT: $deny_rows"
  else
    fail sa-denied "answer: ${denied:0:800}; deny rows: $deny_rows"
  fi

  # 5. Its write waits for a human: prepared, submitted, approved by dave on the page, run once (APR-1).
  calls_before="$(fake_calls create_note)"
  prep="$(sa_client --tool notes.create_note --args "{\"text\":\"$SA_NOTE_TEXT\"}")"
  cs="$(json "$prep" '.structuredContent.changeset.id')"
  hash="$(json "$prep" '.structuredContent.changeset.hash')"
  if [[ "$(json "$prep" '.structuredContent.changeset.status')" != prepared || -z "$cs" ]]; then
    fail sa-approved-write "prepare: ${prep:0:1200}"
    return 0
  fi
  sub="$(sa_client --tool submit_for_approval --args "{\"changeset_id\":\"$cs\",\"hash\":\"$hash\"}")"
  requester="$(psql_q "select requester from change_set where id = '$cs'" 2>&1 || true)"
  gitea_approve "$cs"
  sa_poll_cs "$cs" "$TERMINAL" 120 || true
  calls_after="$(fake_calls create_note)"
  if [[ "$(json "$sub" '.structuredContent.status')" == pending_approval && "$requester" == "service:$SA_CLIENT" &&
    "$APPROVE_HASH" == "$hash" && "$(json "$APPROVE" '.status')" == 200 && "$POLL_STATUS" == completed &&
    "$calls_before" =~ ^[0-9]+$ && "$calls_after" == "$((calls_before + 1))" ]]; then
    pass sa-approved-write "change-set $cs: submit → pending_approval; requester $requester; dave: decide approve $APPROVE_HASH $APPROVE_COUNT → $APPROVE; then $POLL_STATUS; tools/call create_note at the fake $calls_before → $calls_after"
  else
    fail sa-approved-write "submit: ${sub:0:400}; requester: $requester; decide: $APPROVE (hash $APPROVE_HASH vs $hash); status: $POLL_STATUS; tools/call create_note $calls_before → $calls_after"
  fi

  # 6. Neither the token nor the client secret is in the logs (SEC-3). The token is matched through
  #    a pattern file on a file descriptor and the secret inside service-token.mjs, never in argv.
  logs="$(compose logs --no-color api worker keycloak-setup 2>&1 || true)"
  token_hits="$(grep -cF -f <(printf '%s\n' "$token") <<<"$logs" || true)"
  secret_hits="$(node "$REPO/tooling/acceptance/service-token.mjs" --count-secret "$AIOPS_KEYCLOAK_PUBLIC_URL" "$SA_CLIENT" <<<"$logs" 2>&1 || true)"
  if [[ -n "$logs" && "$token_hits" == 0 && "$secret_hits" == 0 ]]; then
    pass sa-no-secret "compose logs api worker keycloak-setup ($(wc -l <<<"$logs") lines): lines with the token $token_hits; occurrences of the client secret $secret_hits"
  else
    fail sa-no-secret "log lines: $(wc -l <<<"$logs"); lines with the token: $token_hits; occurrences of the client secret: $secret_hits"
  fi
}

# Not GROUPS: bash ignores assignments to its own GROUPS array (the user's group IDs).
RUN_GROUPS="${AIOPS_ACCEPT9_GROUPS:-1 2 3 4}"
for g in $RUN_GROUPS; do
  if declare -F "group_$g" >/dev/null; then
    "group_$g"
  else
    fail "group-$g-missing" "not implemented yet"
  fi
done

result
