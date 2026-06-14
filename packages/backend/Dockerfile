# Stage 1: Build (tsc for type checking and shared-types compilation)
FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

# Copy workspace root files. The root tsconfig.json is the shared base that
# every package's tsconfig `extends` ("../../tsconfig.json"); without it the
# `tsc` builds below fail with TS5083 (cannot read file '/app/tsconfig.json').
COPY package.json bun.lock tsconfig.json ./

# Copy every workspace member's package.json. Bun's frozen lockfile install
# requires the manifest of every workspace member to be present, even for
# packages we don't build here (frontend, agora, agora-shared, mcp). Their
# heavy sources are excluded via .dockerignore so the context stays small.
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/agora-shared/package.json packages/agora-shared/
COPY packages/mcp/package.json packages/mcp/
COPY packages/frontend/package.json packages/frontend/
COPY packages/agora/package.json packages/agora/

# Install all workspace deps. --ignore-scripts skips lifecycle scripts
# (notably the root postinstall that compiles shared-types) because the
# source has not been copied yet; shared-types and backend are built
# explicitly below once their sources are present.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

# Build shared-types first, then backend
RUN cd packages/shared-types && bun run build
RUN cd packages/backend && bun run build

# Stage 2: Runtime
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

# ffmpeg powers the /media/poster endpoint (extracts a JPEG frame from remote
# videos). It is run ONLY against a local temp file with networking disabled
# (-protocol_whitelist file); see src/utils/videoPoster.ts.
RUN apk add --no-cache ffmpeg

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/bun.lock ./

# Every workspace member's package.json is required for the frozen lockfile
# install to reconcile, even in the production runtime image.
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/agora-shared/package.json packages/agora-shared/
COPY --from=builder /app/packages/mcp/package.json packages/mcp/
COPY --from=builder /app/packages/frontend/package.json packages/frontend/
COPY --from=builder /app/packages/agora/package.json packages/agora/

# Compiled output for the packages the backend actually runs.
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

# Install production deps only. --ignore-scripts skips the root postinstall
# (shared-types is already built and copied above as dist/).
RUN bun install --frozen-lockfile --production --ignore-scripts

USER appuser
EXPOSE 3000

# Probe on 127.0.0.1 (not localhost): the server binds IPv4 (0.0.0.0), while
# musl/BusyBox resolves "localhost" to ::1 (IPv6) first, which would make the
# healthcheck fail even though the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
