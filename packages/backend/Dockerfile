# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/

# Install all workspace deps
RUN npm ci --workspace=@mention/shared-types --workspace=@mention/backend --include-workspace-root

# Copy source
COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

# Build shared-types first, then backend
RUN npm run build --workspace=@mention/shared-types
RUN npm run build --workspace=@mention/backend

# Stage 2: Runtime
FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

RUN npm ci --workspace=@mention/shared-types --workspace=@mention/backend --include-workspace-root --omit=dev

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "packages/backend/dist/server.js"]
