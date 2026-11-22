#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Stops the Magento sandbox. Pass -v to drop its volumes (the next up.sh reinstalls).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose -p mandate-magento-sandbox down "$@"
