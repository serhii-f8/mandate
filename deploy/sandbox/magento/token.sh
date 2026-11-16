#!/usr/bin/env bash
# Prints a fresh admin token of the Magento sandbox (valid 24 hours). Development only:
# the password is the sandbox's visibly fake default (up.sh). Usage:
#   bash deploy/sandbox/magento/token.sh [base-url]    # default http://127.0.0.1:4390
set -euo pipefail
BASE="${1:-http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}}"
BODY="$(curl -sS --fail-with-body -X POST "${BASE%/}/rest/all/V1/integration/admin/token" \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"dev-only-Admin1"}')" || { echo "token request failed" >&2; exit 1; }
# The response is a JSON string: strip the quotes.
TOKEN="${BODY#\"}"
TOKEN="${TOKEN%\"}"
[[ -n "$TOKEN" && "$TOKEN" != *'{'* ]] || { echo "unexpected token response" >&2; exit 1; }
printf '%s\n' "$TOKEN"
