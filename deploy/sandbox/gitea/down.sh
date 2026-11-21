#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Stops the Gitea sandbox. Pass -v to drop its volume (the next up.sh starts empty).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose -p aiops-gitea-sandbox down "$@"
