#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Brings the Gitea sandbox up (idempotent). Prints "GITEA UP <seconds> <version>" when the API answers.
# Creates the admin mandate-admin only when it is missing. Development only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
START=$(date +%s)
PORT="${MANDATE_GITEA_PORT:-4391}"
docker network inspect mandate-sandbox >/dev/null 2>&1 || docker network create mandate-sandbox >/dev/null
DC=(docker compose -p mandate-gitea-sandbox)
"${DC[@]}" up -d --wait
if ! "${DC[@]}" exec -T -u git gitea gitea admin user list --admin | grep -qw mandate-admin; then
  "${DC[@]}" exec -T -u git gitea gitea admin user create --username mandate-admin \
    --password 'dev-only-Gitea-admin1' --email admin@example.invalid --admin --must-change-password=false >/dev/null
fi
VERSION="$(curl -fsS "http://127.0.0.1:${PORT}/api/v1/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
[[ -n "$VERSION" ]] || { echo "GITEA NOT READY" >&2; exit 1; }
echo "GITEA UP $(( $(date +%s) - START )) ${VERSION}"
