#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
#
# Scans the whole git history for secrets with gitleaks (configuration: .gitleaks.toml).
# Needs Docker. Exit code 0: nothing found; 1: findings (printed redacted).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${GITLEAKS_IMAGE:-ghcr.io/gitleaks/gitleaks:v8.30.0}"
exec docker run --rm -v "$PWD:/repo:ro" "$IMAGE" git /repo --config /repo/.gitleaks.toml --no-banner --redact -v
