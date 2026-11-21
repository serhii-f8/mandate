#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Backs up a running Compose installation (NFR-13): the four PostgreSQL databases and the audit
# archive volume, with a manifest of sizes, SHA-256 sums, the audit chain head and the images.
# Usage: bash deploy/backup/backup.sh [<out-dir>]   (default backups/<UTC timestamp>)
# It never copies .env: the master keys, the Temporal payload keys and the passwords are kept
# elsewhere by the operator. The dumps hold encrypted credentials and personal data; the output
# directory is created readable by the current user only.
# api and worker are stopped while the dumps run, so the aiops database and the audit head do not
# move; Temporal, Keycloak and PostgreSQL keep running. Every docker call goes through
# `docker compose` in the repository root, so COMPOSE_PROJECT_NAME, COMPOSE_FILE and .env apply.
set -euo pipefail

DATABASES=(aiops temporal temporal_visibility keycloak)
ARCHIVE_DIR=/var/lib/aiops/audit-archive

fail() {
  echo "backup: $*" >&2
  exit 1
}

if [ "$#" -gt 1 ] || [ "${1-}" = "-h" ] || [ "${1-}" = "--help" ]; then
  echo "usage: bash deploy/backup/backup.sh [<out-dir>]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
umask 077
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
[ -z "$(ls -A "$OUT")" ] || fail "refusing: $OUT is not empty"
cd "$ROOT"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

STOPPED=0
restart() {
  local rc=$?
  if [ "$STOPPED" = 1 ]; then
    echo "backup: failed (exit $rc); starting api and worker again" >&2
    docker compose start api worker >&2 || echo "backup: could not start api and worker; run: docker compose up -d --wait" >&2
  fi
  exit "$rc"
}
trap restart EXIT

image_of() {
  local id
  id="$(docker compose ps -a -q "$1" | head -n 1)"
  [ -n "$id" ] || fail "no $1 container in this Compose project; is the stack up?"
  docker inspect -f '{ "image": "{{.Config.Image}}", "id": "{{.Image}}", "version": "{{index .Config.Labels "org.opencontainers.image.version"}}" }' "$id"
}
API_IMAGE="$(image_of api)"
WORKER_IMAGE="$(image_of worker)"
docker compose exec -T postgres pg_isready -q -U postgres || fail "postgres is not running; start the stack first"

echo "backup: stopping api and worker" >&2
STOPPED=1
docker compose stop api worker >&2

# The head is read with api and worker stopped: nothing writes or seals audit rows until they start.
VERIFY="$(docker compose run --rm --no-deps -T api node dist/cli.js audit verify)" || fail "audit verify failed: $VERIFY"
HEAD="$(printf '%s\n' "$VERIFY" | sed -n 's/^ok .* head=\([0-9]*:sha256:[0-9a-f]*\)$/\1/p')"
[ -n "$HEAD" ] || fail "unexpected audit verify output: $VERIFY"
echo "backup: audit $VERIFY" >&2

for db in "${DATABASES[@]}"; do
  echo "backup: dumping $db" >&2
  docker compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$OUT/$db.dump"
done

echo "backup: archiving the audit archive volume" >&2
docker compose run --rm --no-deps -T --entrypoint tar api -C "$ARCHIVE_DIR" -cf - . > "$OUT/audit-archive.tar"

{
  printf '{\n  "created": "%s",\n  "files": {\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sep=""
  for f in "${DATABASES[@]/%/.dump}" audit-archive.tar; do
    [ -z "$sep" ] || printf '%s\n' "$sep"
    printf '    "%s": { "bytes": %s, "sha256": "%s" }' "$f" "$(wc -c < "$OUT/$f" | tr -d ' ')" "$(sha256 "$OUT/$f")"
    sep=","
  done
  printf '\n  },\n  "auditHead": "%s",\n  "images": {\n    "api": %s,\n    "worker": %s\n  }\n}\n' "$HEAD" "$API_IMAGE" "$WORKER_IMAGE"
} > "$OUT/manifest.json"

echo "backup: starting api and worker" >&2
docker compose up -d --wait --no-deps api worker >&2
STOPPED=0
echo "backup: done, audit head $HEAD" >&2
echo "$OUT"
