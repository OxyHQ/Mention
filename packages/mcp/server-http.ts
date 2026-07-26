/**
 * Mention MCP Server — HTTP transport for remote clients (Claude Web, etc.)
 *
 * Public URL: https://mcp.mention.earth/
 *
 * Environment variables:
 *   MENTION_API_URL              — Mention REST API (default: https://api.mention.earth)
 *   MENTION_MCP_PUBLIC_URL       — This server's public URL (default: https://mcp.mention.earth)
 *   MENTION_OAUTH_AS_URL         — OAuth authorization server (default: https://api.mention.earth)
 *   MCP_PORT                     — Listen port (default: 3100)
 *   MCP_ALLOWED_ORIGINS          — CORS allowlist (comma-separated)
 *   MCP_MAX_REQUEST_BODY_BYTES   — Max JSON body size (default: 1048576)
 *   MCP_MAX_SESSIONS             — Max active HTTP/SSE sessions (default: 1000)
 *   MENTION_MCP_JWT_SECRET       — Shared HS256 secret (required)
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./lib/create-server.js";
import { requestContext } from "./lib/context.js";
import {
  extractBearerToken,
  fingerprintMcpPrincipal,
  mcpPrincipalMatchesFingerprint,
  type McpAccessTokenClaims,
  verifyMcpAccessToken,
} from "./lib/http-security.js";

const PORT = positiveInteger(process.env.MCP_PORT, 3100, true);
const MAX_REQUEST_BODY_BYTES = positiveInteger(
  process.env.MCP_MAX_REQUEST_BODY_BYTES,
  1_048_576,
);
const MAX_SESSIONS = positiveInteger(process.env.MCP_MAX_SESSIONS, 1_000);
const MCP_PUBLIC_URL = (process.env.MENTION_MCP_PUBLIC_URL || "https://mcp.mention.earth").replace(/\/+$/, "");
const OAUTH_AS_URL = (process.env.MENTION_OAUTH_AS_URL || "https://api.mention.earth").replace(/\/+$/, "");

/** Canonical protected-resource metadata URL advertised in 401 challenges. */
const RESOURCE_METADATA_URL = `${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource`;

const DEFAULT_CORS_ORIGINS = [
  "https://claude.ai",
  "https://www.claude.ai",
  "https://api.anthropic.com",
];

const ALLOWED_ORIGINS = [
  ...DEFAULT_CORS_ORIGINS,
  ...(process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const transports = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();
const sessionLastActivity: Map<string, number> = new Map();
const sessionPrincipalFingerprints: Map<string, string> = new Map();
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  let cleaned = 0;
  const now = Date.now();
  for (const [id, transport] of transports) {
    if (transport instanceof SSEServerTransport) continue;
    const lastActivity = sessionLastActivity.get(id) ?? 0;
    if (now - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      transport.close().catch(() => {});
      cleanupSession(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[mention-mcp-http] Cleaned ${cleaned} idle sessions (${transports.size} active)`);
  }
}, 10 * 60 * 1000);
cleanupInterval.unref();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.writeHead(httpStatus);
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  }));
}

/**
 * Emit an OAuth 2.0 challenge (RFC 9728 §5.1). MCP clients like Claude expect an
 * unauthenticated request to the MCP endpoint to answer 401 with a
 * `WWW-Authenticate: Bearer` header pointing at the protected-resource metadata
 * — that is how the client discovers the authorization server and begins the
 * OAuth flow. Answering 404 here breaks discovery.
 */
function sendUnauthorized(res: ServerResponse): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="mention-mcp", resource_metadata="${RESOURCE_METADATA_URL}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.writeHead(401);
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authentication required." },
    id: null,
  }));
}

function cleanupSession(id: string): void {
  transports.delete(id);
  sessionLastActivity.delete(id);
  sessionPrincipalFingerprints.delete(id);
}

function sessionIsAuthorized(
  sessionId: string,
  claims: McpAccessTokenClaims,
): boolean {
  return mcpPrincipalMatchesFingerprint(
    claims,
    sessionPrincipalFingerprints.get(sessionId),
  );
}

function verifyUserToken(userToken: string): McpAccessTokenClaims | undefined {
  try {
    return verifyMcpAccessToken(userToken, {
      secret: process.env.MENTION_MCP_JWT_SECRET,
      audience: MCP_PUBLIC_URL,
      issuer: OAUTH_AS_URL,
    });
  } catch {
    return undefined;
  }
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  allowZero = false,
): number {
  const parsed = Number.parseInt(raw || "", 10);
  const valid = Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  return valid ? parsed : fallback;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const requestOrigin = Array.isArray(origin) ? origin[0] : origin;
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  // The client reads the session id assigned on `initialize` from the response;
  // it is invisible to browser fetch() unless explicitly exposed.
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/mcp";
}

async function handleStreamableMcp(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string | string[] | undefined>,
  method: "POST" | "GET" | "DELETE",
): Promise<void> {
  const userToken = extractBearerToken(headers);
  const tokenClaims = userToken ? verifyUserToken(userToken) : undefined;
  if (!userToken || !tokenClaims) {
    sendUnauthorized(res);
    return;
  }

  if (method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!sessionId || !(transport instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    if (!sessionIsAuthorized(sessionId, tokenClaims)) {
      sendUnauthorized(res);
      return;
    }
    sessionLastActivity.set(sessionId, Date.now());
    await transport.handleRequest(req, res);
    return;
  }

  if (method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!sessionId || !(transport instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    if (!sessionIsAuthorized(sessionId, tokenClaims)) {
      sendUnauthorized(res);
      return;
    }
    await transport.handleRequest(req, res);
    cleanupSession(sessionId);
    return;
  }

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existingTransport = sessionId ? transports.get(sessionId) : undefined;
    let transport: StreamableHTTPServerTransport;
    const body = await readBody(req);

    if (sessionId && existingTransport instanceof StreamableHTTPServerTransport) {
      if (!sessionIsAuthorized(sessionId, tokenClaims)) {
        sendUnauthorized(res);
        return;
      }
      transport = existingTransport;
      sessionLastActivity.set(sessionId, Date.now());
    } else if (sessionId) {
      sendJsonRpcError(res, 404, -32001, "Session not found. Send an initialize request without a session ID.");
      return;
    } else {
      if (transports.size >= MAX_SESSIONS) {
        sendJsonRpcError(res, 503, -32000, "MCP server is at its session capacity.");
        return;
      }
      const server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          cleanupSession(transport.sessionId);
        }
      };
      await server.connect(transport);
    }

    await requestContext.run({ userToken }, () =>
      transport.handleRequest(req, res, body),
    );

    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport);
      sessionLastActivity.set(transport.sessionId, Date.now());
      sessionPrincipalFingerprints.set(
        transport.sessionId,
        fingerprintMcpPrincipal(tokenClaims),
      );
      console.log(`[mention-mcp-http] New session (${transports.size} active)`);
    }
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof BodyTooLargeError) {
        sendJsonRpcError(res, 413, -32000, error.message);
      } else if (error instanceof SyntaxError) {
        sendJsonRpcError(res, 400, -32700, "Invalid JSON request body.");
      } else {
        console.error("[mention-mcp-http] Request failed", error);
        sendJsonRpcError(res, 500, -32603, "Internal server error.");
      }
    }
  }
}

async function main() {
  const { createServer } = await import("node:http");
  if (!process.env.MENTION_MCP_JWT_SECRET) {
    throw new Error("MENTION_MCP_JWT_SECRET is required for the MCP resource server");
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;

    const query: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const headers = req.headers as Record<string, string | string[] | undefined>;

    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        server: "mention-mcp",
        url: MCP_PUBLIC_URL,
        transport: ["streamable-http", "sse"],
      }));
      return;
    }

    if (pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        // No trailing slash — MUST match the URL the user enters in the client.
        resource: MCP_PUBLIC_URL,
        authorization_servers: [OAUTH_AS_URL],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
      }));
      return;
    }

    if (isMcpPath(pathname)) {
      const method = req.method;
      if (method === "POST" || method === "GET" || method === "DELETE") {
        await handleStreamableMcp(req, res, headers, method);
        return;
      }
    }

    if (pathname === "/sse" && req.method === "GET") {
      const userToken = extractBearerToken(headers);
      const tokenClaims = userToken ? verifyUserToken(userToken) : undefined;
      if (!userToken || !tokenClaims) {
        sendUnauthorized(res);
        return;
      }
      if (transports.size >= MAX_SESSIONS) {
        sendJsonRpcError(res, 503, -32000, "MCP server is at its session capacity.");
        return;
      }
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      sessionPrincipalFingerprints.set(
        transport.sessionId,
        fingerprintMcpPrincipal(tokenClaims),
      );
      res.on("close", () => {
        cleanupSession(transport.sessionId);
      });
      await server.connect(transport);
      return;
    }

    if (pathname === "/messages" && req.method === "POST") {
      const userToken = extractBearerToken(headers);
      const tokenClaims = userToken ? verifyUserToken(userToken) : undefined;
      if (!userToken || !tokenClaims) {
        sendUnauthorized(res);
        return;
      }
      const sessionId = query.sessionId;
      const transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        sendJsonRpcError(res, 400, -32000, "No active SSE session. Connect via GET /sse first.");
        return;
      }
      if (!sessionId || !sessionIsAuthorized(sessionId, tokenClaims)) {
        sendUnauthorized(res);
        return;
      }

      try {
        const body = await readBody(req);
        await requestContext.run({ userToken }, () =>
          transport.handlePostMessage(req, res, body),
        );
      } catch (error) {
        if (!res.headersSent) {
          if (error instanceof BodyTooLargeError) {
            sendJsonRpcError(res, 413, -32000, error.message);
          } else if (error instanceof SyntaxError) {
            sendJsonRpcError(res, 400, -32700, "Invalid JSON request body.");
          } else {
            console.error("[mention-mcp-http] SSE request failed", error);
            sendJsonRpcError(res, 500, -32603, "Internal server error.");
          }
        }
      }
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    })().catch((error) => {
      console.error("[mention-mcp-http] Unhandled request failure", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error.");
      } else {
        res.destroy();
      }
    });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    const address = httpServer.address();
    const listeningPort =
      typeof address === "object" && address !== null ? address.port : PORT;
    console.log(`[mention-mcp-http] Listening on :${listeningPort} — public URL ${MCP_PUBLIC_URL}/`);
  });

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[mention-mcp-http] ${signal} received; draining ${transports.size} session(s)...`);
    clearInterval(cleanupInterval);

    const forceExit = setTimeout(() => {
      console.error("[mention-mcp-http] Graceful shutdown timed out.");
      httpServer.closeAllConnections?.();
      process.exit(1);
    }, 10_000);

    const serverClosed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    const closePromises: Promise<void>[] = [];
    for (const [id, transport] of Array.from(transports.entries())) {
      closePromises.push(Promise.resolve(transport.close()).catch(() => {}));
      cleanupSession(id);
    }

    await Promise.allSettled(closePromises);
    httpServer.closeIdleConnections?.();
    await serverClosed;
    clearTimeout(forceExit);
    console.log("[mention-mcp-http] Shutdown complete.");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[mention-mcp-http] Fatal error:", error);
  process.exit(1);
});
