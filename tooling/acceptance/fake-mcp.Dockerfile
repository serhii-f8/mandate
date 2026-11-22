# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# The fake MCP server of the Phase 9 acceptance (scripts/acceptance/phase-9.sh): tools `lookup` and
# `create_note`, mutable through POST /_control/tools/<name>, and its request log at
# GET /_control/requests (packages/testing/src/fake-mcp-main.ts). Built from the repository root:
#   docker build -f tooling/acceptance/fake-mcp.Dockerfile .
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
ENV PORT=3002
EXPOSE 3002
CMD ["node", "packages/testing/dist/fake-mcp-main.js"]
