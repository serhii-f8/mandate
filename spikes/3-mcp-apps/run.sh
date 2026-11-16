#!/usr/bin/env bash
# Spike 3 — MCP Apps. Starts from clean state, runs all assertions, stops its
# processes. Prints one PASS/FAIL line per assertion; exits non-zero on failure.
# Ports: 4121 MCP server + page, 4122 reference host, 4123 sandbox proxy.
set -uo pipefail
cd "$(dirname "$0")"

PORTS=(4121 4122 4123)
RUN_DIR=.run
PIDS=()

kill_ports() {
  for p in "${PORTS[@]}"; do
    local pids
    pids=$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "# killing leftover listener(s) on :$p: $pids"
      kill $pids 2>/dev/null || true
      sleep 0.5
      kill -9 $pids 2>/dev/null || true
    fi
  done
}

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  kill_ports
}
trap cleanup EXIT

wait_http() {
  local url=$1
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 0.2
  done
  echo "FAIL startup -- $url did not come up"
  exit 1
}

echo "# clean state"
kill_ports
rm -rf dist "$RUN_DIR"
mkdir -p "$RUN_DIR"

if [ ! -d node_modules ]; then
  echo "# npm ci"
  npm ci --no-audit --no-fund >"$RUN_DIR/npm.log" 2>&1 || { echo "FAIL npm-ci"; cat "$RUN_DIR/npm.log"; exit 1; }
fi

echo "# build (vite, single-file bundles: widget, page, host, sandbox)"
if ! npm run --silent build >"$RUN_DIR/build.log" 2>&1; then
  echo "FAIL build"
  cat "$RUN_DIR/build.log"
  exit 1
fi
ls -l dist/widget/widget.html dist/page/page.html dist/host/host/index.html dist/host/host/sandbox.html | awk '{print "# built " $NF " (" $5 " bytes)"}'

echo "# start servers"
node server.mjs >"$RUN_DIR/server.log" 2>&1 &
PIDS+=($!)
node host-serve.mjs >"$RUN_DIR/host.log" 2>&1 &
PIDS+=($!)
wait_http http://localhost:4121/healthz
wait_http http://localhost:4122/
wait_http "http://localhost:4123/sandbox.html"

rc=0
echo "# check-text.mjs (plain MCP client, no Apps capability)"
node check-text.mjs || rc=1
echo "# check-host.mjs (headless Chromium + reference host)"
node check-host.mjs || rc=1

if [ $rc -ne 0 ]; then
  echo "# server log:"; sed 's/^/#   /' "$RUN_DIR/server.log"
  echo "# host log:"; sed 's/^/#   /' "$RUN_DIR/host.log"
  echo "# RESULT: FAIL"
else
  echo "# RESULT: PASS"
fi
exit $rc
