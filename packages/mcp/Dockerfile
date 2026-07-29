# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-slim AS manifests
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
    --filter @mention/shared-types --filter @mention/mcp

COPY packages/shared-types/ packages/shared-types/
COPY packages/mcp/ packages/mcp/

RUN bun run --cwd packages/shared-types build
RUN bun run --cwd packages/mcp build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_PORT=3100
ENV MENTION_API_URL=https://api.mention.earth
ENV MENTION_API_TIMEOUT_MS=10000
ENV MENTION_MCP_PUBLIC_URL=https://mcp.mention.earth
ENV MENTION_OAUTH_AS_URL=https://api.mention.earth

COPY --from=manifests /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=manifests /app/packages/shared-types/package.json packages/shared-types/
COPY --from=manifests /app/packages/mcp/package.json packages/mcp/
COPY --from=manifests /app/packages/backend/package.json packages/backend/
COPY --from=manifests /app/packages/frontend/package.json packages/frontend/
COPY --from=manifests /app/packages/e2e/package.json packages/e2e/

RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @mention/shared-types --filter @mention/mcp
RUN rm -rf packages/frontend packages/backend

COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/mcp/dist/ packages/mcp/dist/

USER bun
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "packages/mcp/dist/server-http.js"]
