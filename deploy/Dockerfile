# Images for the two processes, built from the repository root:
#   docker build -f deploy/Dockerfile --target api .
#   docker build -f deploy/Dockerfile --target worker .
# Debian (glibc) base because @temporalio/worker ships a native core bridge.

FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Fetch dependencies from the lockfile alone, so this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@aiops/api... --filter=@aiops/worker... --filter=@aiops/web --filter=@aiops/widgets
# Self-contained production trees (workspace packages copied in, dev dependencies dropped).
RUN pnpm --filter @aiops/api deploy --prod --legacy /out/api \
 && pnpm --filter @aiops/worker deploy --prod --legacy /out/worker
# The api serves the trusted pages from the built bundle (AIOPS_WEB_DIR), the MCP Apps widget
# bundles (AIOPS_WIDGET_DIR) and loads presets
# from their package.json, preset.yaml and vendored spec alone (AIOPS_PRESET_DIRS).
RUN cp -r apps/web/dist /out/web \
 && cp -r packages/widgets/dist/ui /out/widgets \
 && for dir in presets/*/; do \
      name="$(basename "$dir")"; mkdir -p "/out/presets/$name"; \
      cp "$dir/package.json" "$dir/preset.yaml" "/out/presets/$name/"; \
      cp -r "$dir/spec" "/out/presets/$name/spec"; \
    done

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
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
