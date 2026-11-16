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
RUN pnpm turbo run build --filter=@aiops/api... --filter=@aiops/worker...
# Self-contained production trees (workspace packages copied in, dev dependencies dropped).
RUN pnpm --filter @aiops/api deploy --prod --legacy /out/api \
 && pnpm --filter @aiops/worker deploy --prod --legacy /out/worker

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "dist/main.js"]
