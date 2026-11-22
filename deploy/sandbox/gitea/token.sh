#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Prints a new access token of mandate-admin (40 hex characters; keep it out of logs and files).
# The name is unique per call. Usage: bash deploy/sandbox/gitea/token.sh [scopes]   # default write:issue
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SCOPES="${1:-write:issue}"
TOKEN="$(docker compose -p mandate-gitea-sandbox exec -T -u git gitea gitea admin user generate-access-token \
  -u mandate-admin -t "mandate-$(date +%s%N)" --raw --scopes "$SCOPES" | tr -d '\r\n')"
[[ "$TOKEN" =~ ^[0-9a-f]{40}$ ]] || { echo "unexpected token output" >&2; exit 1; }
printf '%s\n' "$TOKEN"
