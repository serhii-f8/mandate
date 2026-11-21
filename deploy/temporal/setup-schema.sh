#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Creates or upgrades the Temporal schemas in PostgreSQL. Safe to run on every start:
# setup-schema -v 0.0 skips an initialized database and update-schema applies only
# missing versions (verified 2026-11-16, admin-tools 1.32.2, ADR 0012). The databases
# themselves are created by deploy/postgres/init.sh, so upstream's `create` step,
# which fails when the database exists, is not used.
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PWD:?POSTGRES_PWD is required}"
PORT="${DB_PORT:-5432}"
SCHEMA_DIR=/etc/temporal/schema/postgresql/v12

until nc -z -w 5 "$POSTGRES_SEEDS" "$PORT"; do
  echo "waiting for PostgreSQL at $POSTGRES_SEEDS:$PORT"
  sleep 2
done

tool() {
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -p "$PORT" -u "$POSTGRES_USER" --pw "$POSTGRES_PWD" "$@"
}

tool --db temporal setup-schema -v 0.0
tool --db temporal update-schema -d "$SCHEMA_DIR/temporal/versioned"
tool --db temporal_visibility setup-schema -v 0.0
tool --db temporal_visibility update-schema -d "$SCHEMA_DIR/visibility/versioned"
echo "Temporal schema ready"
