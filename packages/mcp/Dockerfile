# Mention MCP server — remote HTTP transport for Claude Web / ChatGPT
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

COPY package.json bunfig.toml bun.lock tsconfig.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/mcp/package.json packages/mcp/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared-types packages/shared-types
COPY packages/mcp packages/mcp

RUN cd packages/shared-types && bun run build
RUN cd packages/mcp && bun run build

FROM oven/bun:1.3.14-slim

WORKDIR /app/packages/mcp

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/shared-types /app/packages/shared-types
COPY --from=builder /app/packages/mcp/dist ./dist
COPY --from=builder /app/packages/mcp/package.json ./

ENV MCP_PORT=3100
ENV MENTION_API_URL=https://api.mention.earth
ENV MENTION_MCP_PUBLIC_URL=https://mcp.mention.earth
ENV MENTION_OAUTH_AS_URL=https://api.mention.earth

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/server-http.js"]
