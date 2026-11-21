#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Restores a backup written by deploy/backup/backup.sh into this Compose installation (NFR-13).
# Usage: bash deploy/backup/restore.sh <backup-dir> [--force]
# Order: check the SHA-256 sums (before any docker call), start PostgreSQL, refuse a non-empty aiops
# database or audit archive unless --force, stop everything that uses the databases, pg_restore each
# database as its owner, restore the audit archive volume, compare the audit verify line with the
# manifest while api and worker are still stopped, then start the stack and verify the chain again.
# The .env of the backed-up installation (master keys, Temporal payload keys, passwords) must be in
# place first: without the same keys the restored credentials and workflow payloads are unreadable.
set -euo pipefail

# Database and owner role, as created by deploy/postgres/init.sh.
DATABASES=(aiops:aiops temporal:temporal temporal_visibility:temporal keycloak:keycloak)
FILES=(aiops.dump temporal.dump temporal_visibility.dump keycloak.dump audit-archive.tar)
ARCHIVE_DIR=/var/lib/aiops/audit-archive
USERS_OF_DB=(api worker temporal temporal-namespace temporal-schema keycloak keycloak-setup)

fail() {
  echo "restore: $*" >&2
  exit 1
}

DIR=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) DIR="" && break ;;
    *) [ -z "$DIR" ] || { DIR="" && break; }; DIR="$arg" ;;
  esac
done
if [ -z "$DIR" ]; then
  echo "usage: bash deploy/backup/restore.sh <backup-dir> [--force]" >&2
  exit 2
fi
[ -f "$DIR/manifest.json" ] || fail "no manifest.json in $DIR"
DIR="$(cd "$DIR" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

# 1. Integrity, before anything is touched. The manifest is the one backup.sh writes, one file per line.
for f in "${FILES[@]}"; do
  line="$(grep -F "\"$f\": {" "$DIR/manifest.json" || true)"
  want="$(printf '%s\n' "$line" | sed -n 's/.*"sha256": "\([0-9a-f]\{64\}\)".*/\1/p')"
  [ -n "$want" ] || fail "manifest.json has no sha256 for $f"
  [ -f "$DIR/$f" ] || fail "missing file $f"
  [ "$(sha256 "$DIR/$f")" = "$want" ] || fail "checksum mismatch: $f; nothing was restored"
done
HEAD="$(sed -n 's/^ *"auditHead": "\([0-9]*:sha256:[0-9a-f]*\)",\{0,1\}$/\1/p' "$DIR/manifest.json")"
[ -n "$HEAD" ] || fail "manifest.json has no auditHead"
WANT_VERIFY="$(sed -n 's/^ *"auditVerify": "\(ok sealed=[0-9]* unsealed=[0-9]* from=[0-9]* head=[0-9]*:sha256:[0-9a-f]*\)",\{0,1\}$/\1/p' "$DIR/manifest.json")"
[ -n "$WANT_VERIFY" ] || fail "manifest.json has no auditVerify"
echo "restore: checksums ok, backup audit head $HEAD" >&2

# 2. PostgreSQL only.
docker compose up -d --wait postgres >&2

# 3. Never overwrite an audit trail by mistake: neither audit rows nor archive files without --force.
# A database without the aiops tables (fresh volume, init.sh only) counts as empty.
psql_aiops() { docker compose exec -T postgres psql -U postgres -d aiops -v ON_ERROR_STOP=1 -tAc "$1"; }
if [ "$(psql_aiops "SELECT to_regclass('public.audit_event') IS NOT NULL")" = t ] &&
  [ "$(psql_aiops "SELECT EXISTS (SELECT 1 FROM public.audit_event)")" = t ]; then
  if [ "$FORCE" = 1 ]; then
    echo "restore: database not empty; --force given, its audit trail is discarded" >&2
  else
    fail "refusing: database not empty (aiops.audit_event has rows); pass --force to replace it"
  fi
fi
ARCHIVE_COUNT="$(docker compose run --rm --no-deps -T --entrypoint sh api -c "ls -A $ARCHIVE_DIR | wc -l")"
if [ "$(printf '%s' "$ARCHIVE_COUNT" | tr -d ' \r\n')" != 0 ]; then
  if [ "$FORCE" = 1 ]; then
    echo "restore: audit archive not empty; --force given, its files are discarded" >&2
  else
    fail "refusing: audit archive not empty; pass --force to replace it"
  fi
fi

# 4. Nothing may hold a connection or write while the databases are replaced.
docker compose stop "${USERS_OF_DB[@]}" >&2

# 5. Each database in one transaction, objects owned by its application role.
for entry in "${DATABASES[@]}"; do
  db="${entry%%:*}"
  owner="${entry#*:}"
  echo "restore: restoring $db" >&2
  docker compose exec -T postgres pg_restore -U postgres --clean --if-exists --no-owner --role="$owner" \
    --single-transaction --exit-on-error -d "$db" < "$DIR/$db.dump" ||
    fail "pg_restore of $db failed; the stack is left stopped; fix the cause and run the restore again with --force"
done

# 6. The audit archive volume, replaced as a whole.
echo "restore: restoring the audit archive volume" >&2
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  "cd $ARCHIVE_DIR && find . -mindepth 1 -delete && tar -xf -" < "$DIR/audit-archive.tar" ||
  fail "restoring the audit archive failed; the stack is left stopped; fix the cause and run the restore again with --force"

# 7. The audit state must be exactly the one recorded at backup time (sealed and unsealed counts,
# chain start and head), checked before api and worker start: they write and seal audit rows as
# soon as they run, and nothing else changes the restored database before that.
VERIFY="$(docker compose run --rm --no-deps -T api node dist/cli.js audit verify)" ||
  fail "audit verify failed after the restore: $VERIFY; the stack is left stopped"
[ "$VERIFY" = "$WANT_VERIFY" ] ||
  fail "audit head mismatch: backup '$WANT_VERIFY', restored '$VERIFY'; the stack is left stopped"
echo "audit head matches: $HEAD"

# 8. The whole stack, then the chain once more (the head may have advanced by now).
docker compose up -d --wait >&2
VERIFY="$(docker compose exec -T api node dist/cli.js audit verify)" || fail "audit verify failed after start: $VERIFY"
echo "restore: done, audit $VERIFY"
