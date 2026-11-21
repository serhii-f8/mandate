#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# The whole CI run, identical locally and in .github/workflows/ci.yml (ADR 0001:
# "CI is green" means this script passes). Needs Docker (Testcontainers) and
# network access (images, Temporal test server download).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { echo; echo "=== $*"; }

step install;           pnpm install --frozen-lockfile
step "dependency scan"; bash scripts/dependency-scan.sh
step lint;              pnpm lint
step typecheck;         pnpm typecheck
step build;             pnpm build
step "public API reports"; node tooling/versioning/api-report.mjs connector-sdk --check && node tooling/versioning/api-report.mjs config --check && node tooling/versioning/api-report.mjs preset --check && node tooling/versioning/semver-gate.mjs
step "unit tests";      pnpm test
step "integration tests (PostgreSQL, Temporal test server, replay gate)"; pnpm test:int
step "end-to-end tests"; pnpm test:e2e
echo; echo "CI: all steps passed"
