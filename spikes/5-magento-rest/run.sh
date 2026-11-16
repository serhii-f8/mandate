#!/usr/bin/env bash
# Runs all spike-5 assertions against an already running sandbox (see up.sh).
set -euo pipefail
cd "$(dirname "$0")"
if ! curl -fs -o /dev/null -m 5 -X POST http://localhost:4380/rest/V1/integration/admin/token \
  -H 'content-type: application/json' -d '{"username":"admin","password":"Admin123!spike"}'; then
  echo "FAIL sandbox-up  # run ./up.sh first"; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
node check.mjs
