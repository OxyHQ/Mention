# Stage 1: Build (tsc for type checking and shared-types compilation)
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/

# Install all workspace deps
RUN bun install --frozen-lockfile

# Copy source
COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

# Build shared-types first, then backend
RUN cd packages/shared-types && bun run build
RUN cd packages/backend && bun run build

# Stage 2: Runtime
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

RUN bun install --frozen-lockfile --production

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
