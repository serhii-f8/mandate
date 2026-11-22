# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The AI Operations Layer Authors
# Images for the two processes, built from the repository root:
#   docker build -f deploy/Dockerfile --target api .
#   docker build -f deploy/Dockerfile --target worker .
# Debian (glibc) base because @temporalio/worker ships a native core bridge.

FROM node:26-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Fetch dependencies from the lockfile alone, so this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@aiops/api... --filter=@aiops/worker... --filter=@aiops/web --filter=@aiops/widgets --filter='./presets/*'
# Self-contained production trees (workspace packages copied in, dev dependencies dropped).
RUN pnpm --filter @aiops/api deploy --prod --legacy /out/api \
 && pnpm --filter @aiops/worker deploy --prod --legacy /out/worker
# The api serves the trusted pages from the built bundle (AIOPS_WEB_DIR), the MCP Apps widget
# bundles (AIOPS_WIDGET_DIR) and loads presets
# from their packed package: package.json, preset.yaml, vendored spec and code `dist` (AIOPS_PRESET_DIRS).
# Every presets/* directory is built and packed with its own `files` list (dist, preset.yaml, spec, code),
# so a new preset needs no Dockerfile edit. `npm pack` is the fallback should `pnpm pack` refuse a private package.
RUN cp -r apps/web/dist /out/web \
 && cp -r packages/widgets/dist/ui /out/widgets \
 && mkdir -p /tmp/packs /out/presets \
 && for dir in presets/*/; do \
      name="$(basename "$dir")"; mkdir -p "/tmp/packs/$name" "/out/presets/$name"; \
      (cd "$dir" && (pnpm pack --pack-destination "/tmp/packs/$name" || npm pack --pack-destination "/tmp/packs/$name")); \
      tar -xzf "/tmp/packs/$name"/*.tgz -C "/out/presets/$name" --strip-components=1; \
    done

FROM node:26-bookworm-slim AS runtime
# The product version (NFR-18); api and worker inherit it from this stage.
LABEL org.opencontainers.image.version="1.0.0"
ENV NODE_ENV=production
WORKDIR /app
# Audit archive directory (AUD-7), owned by node so a fresh named volume mounted here inherits it.
RUN mkdir -p /var/lib/aiops/audit-archive && chown node:node /var/lib/aiops/audit-archive
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
COPY --from=build --chown=node:node /out/presets ./presets
COPY --from=build --chown=node:node /out/web ./web
COPY --from=build --chown=node:node /out/widgets ./widgets
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
# The worker loads the configuration exactly as the api does, presets included (AIOPS_PRESET_DIRS).
COPY --from=build --chown=node:node /out/presets ./presets
CMD ["node", "dist/main.js"]
