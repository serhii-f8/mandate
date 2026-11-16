#!/usr/bin/env bash
# Spike 4 — Temporal versioning. Starts from clean state, waits for readiness, runs check.mjs, tears down.
set -uo pipefail
cd "$(dirname "$0")"
P=fde-spike-4
cleanup() { docker compose -p "$P" down -v >/dev/null 2>&1; }
trap cleanup EXIT

[ -d node_modules/@temporalio/worker ] || npm install --no-audit --no-fund >/dev/null
docker compose -p "$P" down -v >/dev/null 2>&1          # clean state
docker compose -p "$P" up -d >/dev/null || { echo "FAIL compose-up"; exit 1; }

ready=0
for _ in $(seq 1 90); do
  if docker compose -p "$P" exec -T temporal temporal operator cluster health --address 127.0.0.1:7233 >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "FAIL server-ready"; docker compose -p "$P" logs --tail 20 temporal; exit 1; }
echo "# server ready: $(docker compose -p "$P" exec -T temporal temporal --version)"

node check.mjs; rc=$?
if [ -x ./check-versioning.mjs ] || [ -f ./check-versioning.mjs ]; then
  node check-versioning.mjs || rc=1
fi
exit $rc
