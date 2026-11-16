#!/bin/sh
# Creates the Temporal namespace if it does not exist yet. Safe to run on every start.
set -eu

NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
ADDRESS="${TEMPORAL_ADDRESS:-temporal:7233}"

attempt=1
until temporal operator cluster health --address "$ADDRESS" >/dev/null 2>&1; do
  if [ "$attempt" -ge 60 ]; then
    echo "Temporal at $ADDRESS did not become healthy"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if temporal operator namespace describe -n "$NAMESPACE" --address "$ADDRESS" >/dev/null 2>&1; then
  echo "namespace $NAMESPACE exists"
else
  temporal operator namespace create -n "$NAMESPACE" --retention 7d --address "$ADDRESS"
  echo "namespace $NAMESPACE created"
fi
