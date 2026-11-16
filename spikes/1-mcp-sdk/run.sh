#!/usr/bin/env bash
# Spike 1 — MCP SDK. Starts two server processes sharing one task-state
# directory, runs check.mjs, stops the servers. Exits non-zero on any FAIL.
set -euo pipefail
cd "$(dirname "$0")"

PORT_A=4101
PORT_B=4102
export TASK_DIR="$PWD/.task-state"
LOG_DIR="$PWD/logs"

kill_port() {
  local pids
  pids=$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  if [ -n "$pids" ]; then
    echo "run.sh: killing leftover process(es) on :$1: $pids"
    kill $pids 2>/dev/null || true
    sleep 0.5
  fi
}

wait_port() {
  for _ in $(seq 1 50); do
    if ss -ltnH "sport = :$1" | grep -q LISTEN; then return 0; fi
    sleep 0.1
  done
  echo "run.sh: server on :$1 did not start"; cat "$LOG_DIR/server-$1.log"; return 1
}

# ---- clean state ----
kill_port $PORT_A
kill_port $PORT_B
rm -rf "$TASK_DIR" "$LOG_DIR"
mkdir -p "$TASK_DIR" "$LOG_DIR"
[ -d node_modules ] || npm ci --silent

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
  echo "run.sh: servers stopped"
}
trap cleanup EXIT

PORT=$PORT_A node server.mjs >"$LOG_DIR/server-$PORT_A.log" 2>&1 & PIDS+=($!)
PORT=$PORT_B node server.mjs >"$LOG_DIR/server-$PORT_B.log" 2>&1 & PIDS+=($!)
wait_port $PORT_A
wait_port $PORT_B

echo "run.sh: @modelcontextprotocol/server $(node -p "require('./node_modules/@modelcontextprotocol/server/package.json').version"), client $(node -p "require('./node_modules/@modelcontextprotocol/client/package.json').version"), ext-tasks $(node -p "require('./node_modules/@modelcontextprotocol/ext-tasks/package.json').version"), node $(node -v)"

status=0
PORT_A=$PORT_A PORT_B=$PORT_B node check.mjs || status=$?
echo "run.sh: task files written to shared store: $(ls "$TASK_DIR" | grep -c '\.json$' || true)"
exit $status
