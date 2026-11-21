#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Stops the Magento sandbox. Pass -v to drop its volumes (the next up.sh reinstalls).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose -p aiops-magento-sandbox down "$@"
