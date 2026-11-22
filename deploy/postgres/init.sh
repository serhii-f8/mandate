#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Runs once, on the first start of an empty data directory (docker-entrypoint-initdb.d).
# One role and database per component (ADR 0012); passwords come from the environment.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v mandate_pw="$MANDATE_DB_PASSWORD" \
  -v temporal_pw="$TEMPORAL_DB_PASSWORD" \
  -v keycloak_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE mandate LOGIN PASSWORD :'mandate_pw';
CREATE DATABASE mandate OWNER mandate;

CREATE ROLE temporal LOGIN PASSWORD :'temporal_pw';
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal;

CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL
