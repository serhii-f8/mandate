# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# The fake Magento catalog of the restart acceptance (scripts/acceptance/restart.sh): product reads,
# the async bulk write and its detailed status, with per-SKU submission counts at GET /_control/state,
# POST /_control/open-polls {n} and POST /_control/reset (packages/testing/src/fake-magento-main.ts).
# PRODUCTS sets the number of seed products RST-0001...; built from the repository root:
#   docker build -f tooling/acceptance/fake-magento.Dockerfile .
# Test tooling only; never part of a deployment.
FROM node:22-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Fetch dependencies from the lockfile alone, so this layer survives source edits (as deploy/Dockerfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @mandate/testing...
RUN pnpm --filter @mandate/testing... build
ENV PORT=3003
EXPOSE 3003
CMD ["node", "packages/testing/dist/fake-magento-main.js"]
