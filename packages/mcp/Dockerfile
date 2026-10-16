# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Base images and the Dockerfile frontend are pinned by digest: the digest is
# what the build pulls, and the tag is kept only for readers and for
# scripts/validate-bun-pins.mjs. Bumping either (Bun release or base OS
# security fixes) needs a new multi-arch index digest, then an owner review and
# `python3 .github/scripts/reviewed-image.py pin`.

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS manifests
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY patches/ patches/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/mcp/package.json packages/mcp/
COPY packages/frontend/package.json packages/frontend/
COPY packages/e2e/package.json packages/e2e/
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile --ignore-scripts --lockfile-only

FROM manifests AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --omit=peer --omit=optional \
    --filter @mention/shared-types --filter @mention/mcp

COPY packages/shared-types/ packages/shared-types/
COPY packages/mcp/ packages/mcp/

RUN bun run --cwd packages/shared-types build
RUN bun run --cwd packages/mcp build

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_PORT=3100
ENV MENTION_API_URL=https://api.mention.earth
ENV MENTION_API_TIMEOUT_MS=10000
ENV MENTION_MCP_PUBLIC_URL=https://mcp.mention.earth
ENV OXY_API_URL=https://api.oxy.so

COPY --from=manifests /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=manifests /app/patches/ patches/
COPY --from=manifests /app/packages/shared-types/package.json packages/shared-types/
COPY --from=manifests /app/packages/mcp/package.json packages/mcp/
COPY --from=manifests /app/packages/backend/package.json packages/backend/
COPY --from=manifests /app/packages/frontend/package.json packages/frontend/
COPY --from=manifests /app/packages/e2e/package.json packages/e2e/
COPY --from=manifests /app/packages/contracts/package.json packages/contracts/
COPY --from=manifests /app/packages/sdk/package.json packages/sdk/

RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @mention/shared-types --filter @mention/mcp
RUN rm -rf packages/frontend packages/backend packages/e2e packages/contracts packages/sdk

COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/mcp/dist/ packages/mcp/dist/

USER bun
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "packages/mcp/dist/server-http.js"]
