#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
out="$(mktemp)"; trap 'rm -f "$out"' EXIT
pnpm audit --json > "$out" || true   # pnpm audit exits non-zero when it finds anything
node tooling/security/audit-gate.mjs "$out" security/audit-allowlist.yaml
