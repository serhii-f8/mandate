#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Phase 10 acceptance (SPEC section 7, design phase-10-release-docs §6): a clean-room dry run of the
# public guide. A fresh clone of HEAD runs the marked `doc-test` blocks of docs/guide/ through
# tooling/doc-test/run.mjs, exactly as a reader would type them from the repository root, with only
# the ports changed through the variables the guide documents:
#   docs-install               section install: the stack starts and /readyz answers (NFR-9);
#   docs-attach-magento        section attach: sandbox up and seeded, my-config attached through
#                              COMPOSE_FILE in .env, token entered on the credential page, test ok;
#   docs-configure-role        section role: the guide's role applied with `config apply`, `config
#                              explain` allows acme and denies globex;
#   docs-approved-bulk-update  section bulk: prepare, submit, dave approves on the page, completed;
#                              plus evidence here: the change-set's batches carry a Magento bulk UUID
#                              (change_batch.upstream_batch_id) and `changeset.batch` audit rows exist,
#                              and every acme product in the sandbox carries the change-set's value;
#   docs-backup-restore        section backup: a pending change-set, backup, `docker compose down -v`,
#                              restore (audit head checked against the manifest), the completed
#                              change-set is visible, the pending one is approved and completes, the
#                              connection test passes (NFR-13);
#   docs-rollback              section rollback: the last change-set (the backup page's) is rolled
#                              back on the page with a fresh login, ends rolled_back, and every acme
#                              product carries the bulk page's value again (EXE-8);
#   docs-lint                  the doc lint unit tests pass in the clone.
# The runner runs twice: `install attach role bulk`, then the bulk evidence (before the backup
# section overwrites the acme values), then `backup` with CHANGESET_ID (the only change-set of the
# fresh stack, read from the database) in its environment, as the reader's shell still has it.
# The runner prints `pass|fail|skip <section>`; fail and skip are FAIL here. On a failure the tail of
# the masked .doc-test.log is printed.
# The Magento sandbox (network mandate-sandbox, port MANDATE_MAGENTO_PORT, default 4390) is shared with
# other checkouts: the guide brings it up and seeds it idempotently; this script never stops it. Only
# this run's Compose project is removed on exit.
# Prints one PASS/FAIL line per check and `# RESULT: PASS|FAIL`, then the manual steps of design §7;
# exits non-zero if any check fails. Not part of CI: needs the Magento sandbox.
# Secrets: the guide captures tokens and cookies into variables; the runner masks them in its log.
# This script holds the Magento token in a variable and passes it to node through the environment.
# Needs: docker with compose v2, git, node with corepack, curl.
# The functions run through the trap, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
FAILED=0

# Runner section → check name. tooling/test/docs.unit.test.ts parses this list (R9).
SECTION_CHECKS=(
  install:docs-install
  attach:docs-attach-magento
  role:docs-configure-role
  bulk:docs-approved-bulk-update
  backup:docs-backup-restore
  rollback:docs-rollback
)

pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=1; }
check_of() {
  local e
  for e in "${SECTION_CHECKS[@]}"; do [[ "${e%%:*}" == "$1" ]] && { echo "${e#*:}"; return 0; }; done
  echo "unknown-section-$1"
}

WORK="$(mktemp -d)"
CLONE="$WORK/mandate"
export COMPOSE_PROJECT_NAME="mandate-accept10-$$"
# The guide sets COMPOSE_FILE in the clone's .env; a value in this shell would win over it.
unset COMPOSE_FILE COMPOSE_PROFILES

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
MANDATE_API_PORT="$(free_port)" MANDATE_KEYCLOAK_PORT="$(free_port)" MANDATE_TEMPORAL_PORT="$(free_port)" MANDATE_POSTGRES_PORT="$(free_port)"
MANDATE_MAILPIT_PORT="$(free_port)"
export MANDATE_API_PORT MANDATE_KEYCLOAK_PORT MANDATE_TEMPORAL_PORT MANDATE_POSTGRES_PORT MANDATE_MAILPIT_PORT
export MANDATE_KEYCLOAK_PUBLIC_URL="http://localhost:${MANDATE_KEYCLOAK_PORT}"
export MANDATE_MCP_RESOURCE="http://localhost:${MANDATE_API_PORT}/mcp"
export MANDATE_PUBLIC_URL="http://localhost:${MANDATE_API_PORT}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
SANDBOX="http://127.0.0.1:${MANDATE_MAGENTO_PORT:-4390}"

dc() { (cd "$CLONE" && docker compose "$@"); }
psql_q() { dc exec -T postgres psql -U mandate -d mandate -tAc "$1"; }

cleanup() {
  # The clone's .env names the attach override; its sandbox network is external and stays.
  (cd "$CLONE" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

manual_steps() {
  cat <<'EOF'
# Newcomer walkthrough (ADR 0059; SPEC section 7): someone new to the repository, in a clean clone, reads
#   only README.md, docs/guide/ and examples/ as rendered, follows installation.md ->
#   connecting-magento.md -> roles-and-approvals.md -> first-bulk-update.md, and reports pass or fail,
#   the time and every unclear place. 
EOF
}

# Runs the guide's sections; prints one PASS/FAIL per section. Returns 1 if any section did not pass.
run_sections() {
  local out rc=0 line verdict section check
  out="$(cd "$CLONE" && node tooling/doc-test/run.mjs . "$@" 2>&1)" || rc=$?
  cp "$CLONE/.doc-test.log" "$WORK/doc-test-$1.log" 2>/dev/null || true
  for section in "$@"; do
    check="$(check_of "$section")"
    line="$(grep -E "^(pass|fail|skip) ${section}( |$)" <<<"$out" | head -1 || true)"
    verdict="${line%% *}"
    case "$verdict" in
      pass) pass "$check" "runner: $line" ;;
      fail) fail "$check" "runner: $line" ;;
      skip) fail "$check" "runner: $line (an earlier section failed)" ;;
      *) fail "$check" "runner printed no line for $section (exit $rc): $(tail -3 <<<"$out" | tr '\n' ' ')" ;;
    esac
  done
  if ((rc != 0)); then
    echo "# runner exit $rc; tail of .doc-test.log:"
    tail -40 "$WORK/doc-test-$1.log" 2>/dev/null | sed 's/^/#   /' || true
    return 1
  fi
}

echo "# Phase 10 acceptance of ${SHA:0:12} (project $COMPOSE_PROJECT_NAME, api port $MANDATE_API_PORT, sandbox $SANDBOX)"

git clone --quiet --no-local --no-checkout "$REPO" "$CLONE"
git -C "$CLONE" checkout --quiet --detach "$SHA"

if ! (cd "$CLONE" && corepack pnpm install --frozen-lockfile >"$WORK/install.log" 2>&1); then
  echo "# pnpm install failed in the clone:"; tail -20 "$WORK/install.log" | sed 's/^/#   /'
  for e in "${SECTION_CHECKS[@]}"; do fail "${e#*:}" "pnpm install --frozen-lockfile failed in the clone"; done
  fail docs-lint "pnpm install --frozen-lockfile failed in the clone"
  echo "# RESULT: FAIL"; exit 1
fi

# ---- Sections install, attach, role, bulk ----------------------------------------------------------
BULK_OK=1
run_sections install attach role bulk || BULK_OK=0

# ---- Bulk evidence: the bulk endpoint was used, and Magento has the value on every acme product ----
CS=""
if ((BULK_OK)); then
  IDS="$(psql_q "select id from change_set where operation = 'catalog.update_content' order by created_at" 2>&1 || true)"
  if [[ "$IDS" =~ ^[0-9a-f-]{36}$ ]]; then
    CS="$IDS"
    KEYWORD="$(psql_q "select args->'changes'->>'meta_keyword' from change_set where id = '$CS'" 2>&1 || true)"
    BULKS="$(psql_q "select count(*) from change_batch where changeset_id = '$CS' and upstream_batch_id is not null" 2>&1 || true)"
    AUDITS="$(psql_q "select count(*) from audit_event where action = 'changeset.batch' and changeset_id = '$CS'" 2>&1 || true)"
    MAGENTO_TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>/dev/null || true)"
    # total|carrying: acme products in the sandbox, and those whose meta_keyword is the change-set's value.
    COUNTS="$(MAGENTO_TOKEN="$MAGENTO_TOKEN" node -e "
      const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'acme', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '1000' });
      fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
        .then((r) => r.json())
        .then((b) => console.log((b?.total_count ?? '') + '|' + (b?.items ?? []).filter((p) => (p?.custom_attributes ?? []).some((a) => a.attribute_code === 'meta_keyword' && a.value === process.argv[2])).length))
        .catch(() => console.log('|'));" "$SANDBOX" "$KEYWORD" || echo '|')"
    unset MAGENTO_TOKEN
    TOTAL="${COUNTS%%|*}" CARRY="${COUNTS#*|}"
    if [[ "$BULKS" =~ ^[0-9]+$ ]] && ((BULKS >= 1)) && [[ "$AUDITS" =~ ^[0-9]+$ ]] && ((AUDITS >= 1)) &&
      [[ "$TOTAL" =~ ^[0-9]+$ ]] && ((TOTAL >= 1)) && [[ "$CARRY" == "$TOTAL" ]] && [[ -n "$KEYWORD" ]]; then
      pass docs-approved-bulk-update "evidence: change-set $CS: $BULKS batch(es) with a Magento bulk UUID, $AUDITS changeset.batch audit row(s); $CARRY of $TOTAL acme products carry '$KEYWORD'"
    else
      fail docs-approved-bulk-update "evidence: change-set $CS: batches with a bulk UUID '$BULKS', changeset.batch audit rows '$AUDITS', acme products carrying '$KEYWORD': '$CARRY' of '$TOTAL'"
    fi
  else
    fail docs-approved-bulk-update "evidence: expected exactly one catalog.update_content change-set, got: $(tr '\n' ' ' <<<"$IDS")"
  fi
fi

# ---- Section backup ----------------------------------------------------------------------------------
if [[ -n "$CS" ]]; then
  export CHANGESET_ID="$CS"
  run_sections backup || true
else
  fail docs-backup-restore "not run: section bulk or its evidence failed (no guide change-set)"
fi

# ---- Section rollback: the reader rolls back the last change-set they made (the backup page's) -------
LAST="$(psql_q "select id || ' ' || hash from change_set where operation = 'catalog.update_content' order by created_at desc limit 1" 2>&1 || true)"
if [[ -n "$CS" && "$LAST" =~ ^[0-9a-f-]{36}\ sha256:[0-9a-f]{64}$ && "${LAST%% *}" != "$CS" ]]; then
  if CHANGESET_ID="${LAST%% *}" CHANGESET_HASH="${LAST#* }" DEV_PASSWORD=dev-only-password run_sections rollback; then
    MAGENTO_TOKEN="$(bash "$REPO/deploy/sandbox/magento/token.sh" "$SANDBOX" 2>/dev/null || true)"
    COUNTS="$(MAGENTO_TOKEN="$MAGENTO_TOKEN" node -e "
      const q = new URLSearchParams({ 'searchCriteria[filter_groups][0][filters][0][field]': 'brand', 'searchCriteria[filter_groups][0][filters][0][value]': 'acme', 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq', 'searchCriteria[pageSize]': '1000' });
      fetch(process.argv[1] + '/rest/all/V1/products?' + q, { headers: { authorization: 'Bearer ' + process.env.MAGENTO_TOKEN } })
        .then((r) => r.json())
        .then((b) => console.log((b?.total_count ?? '') + '|' + (b?.items ?? []).filter((p) => (p?.custom_attributes ?? []).some((a) => a.attribute_code === 'meta_keyword' && a.value === process.argv[2])).length))
        .catch(() => console.log('|'));" "$SANDBOX" "$KEYWORD" || echo '|')"
    unset MAGENTO_TOKEN
    TOTAL="${COUNTS%%|*}" CARRY="${COUNTS#*|}"
    if [[ "$TOTAL" =~ ^[0-9]+$ ]] && ((TOTAL >= 1)) && [[ "$CARRY" == "$TOTAL" ]]; then
      pass docs-rollback "evidence: change-set ${LAST%% *} rolled back; $CARRY of $TOTAL acme products carry '$KEYWORD' again"
    else
      fail docs-rollback "evidence: after the rollback, acme products carrying '$KEYWORD': '$CARRY' of '$TOTAL'"
    fi
  fi
else
  fail docs-rollback "not run: no change-set of the backup page to roll back (got '$LAST')"
fi

# ---- Doc lint in the clone --------------------------------------------------------------------------
if LINT="$(cd "$CLONE" && corepack pnpm --filter @mandate/tooling exec vitest run --project unit test/docs.unit.test.ts 2>&1)"; then
  pass docs-lint "$(grep -E 'Tests +[0-9]+' <<<"$LINT" | tr -s ' ' | sed 's/^ //' | head -1)"
else
  fail docs-lint "$(grep -E 'FAIL|Tests +[0-9]+' <<<"$LINT" | tr -s ' ' | head -5 | tr '\n' ' ')"
fi

if [[ "$FAILED" == 0 ]]; then echo "# RESULT: PASS"; else echo "# RESULT: FAIL"; fi
manual_steps
exit "$FAILED"
