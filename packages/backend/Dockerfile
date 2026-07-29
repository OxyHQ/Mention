# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS manifests
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/mcp/package.json packages/mcp/
COPY packages/frontend/package.json packages/frontend/
COPY packages/e2e/package.json packages/e2e/
RUN bun install --frozen-lockfile --ignore-scripts --lockfile-only

FROM manifests AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --omit=peer --omit=optional \
    --filter @mention/shared-types --filter @mention/backend

COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

RUN bun run --cwd packages/shared-types build
RUN bun run --cwd packages/backend build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

# ffmpeg powers bounded local frame extraction for /media/poster.
RUN apk add --no-cache ffmpeg
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

ENV NODE_ENV=production

COPY --from=manifests /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=manifests /app/packages/shared-types/package.json packages/shared-types/
COPY --from=manifests /app/packages/backend/package.json packages/backend/
COPY --from=manifests /app/packages/mcp/package.json packages/mcp/
COPY --from=manifests /app/packages/frontend/package.json packages/frontend/
COPY --from=manifests /app/packages/e2e/package.json packages/e2e/

RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @mention/shared-types --filter @mention/backend
RUN rm -rf packages/frontend packages/mcp

COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
