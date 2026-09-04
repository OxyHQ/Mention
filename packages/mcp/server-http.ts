/**
 * Mention MCP Server — HTTP transport for remote clients (Claude Web, etc.)
 *
 * Public URL: https://mcp.mention.earth/
 *
 * Environment variables:
 *   MENTION_API_URL              — Mention REST API (default: https://api.mention.earth)
 *   MENTION_MCP_PUBLIC_URL       — This server's public URL (default: https://mcp.mention.earth)
 *   OXY_API_URL                  — Central Oxy OAuth authority (default: https://api.oxy.so)
 *   OXY_SERVICE_API_KEY          — Mention MCP service credential id (required)
 *   OXY_SERVICE_API_SECRET       — Mention MCP service credential secret (required)
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
import {
  buildProtectedResourceMetadata,
  extractBearerToken,
} from "@oxyhq/mcp";
import { MENTION_MCP_CAPABILITIES } from "@mention/shared-types/mcpCapabilities";
import {
  loadMcpHttpConfig,
  type McpHttpConfig,
} from "./lib/config.js";
import { createMcpServer } from "./lib/create-server.js";
import { requestContext } from "./lib/context.js";
import {
  fingerprintMcpPrincipal,
  type AuthenticatedMcpToken,
} from "./lib/http-security.js";
import { logError, logInfo, logWarn } from "./lib/logger.js";
import { McpSessionRegistry } from "./lib/session-registry.js";
import {
  authenticateMcpAccessToken,
  createCentralTokenIntrospector,
} from "./lib/token-authenticator.js";
import { createMentionCapabilityAuthority } from "./lib/capability-authority.js";
import { handleMentionCapabilityRequest } from "./lib/capability-http.js";

const config = loadConfiguration();
const PORT = config.port;
const MAX_REQUEST_BODY_BYTES = config.maxRequestBodyBytes;
const MAX_SESSIONS = config.maxSessions;
const MCP_PUBLIC_URL = config.publicUrl;
const OAUTH_AS_URL = config.oxyApiUrl;
const introspectCentralToken = createCentralTokenIntrospector(config);
const capabilityAuthority = createMentionCapabilityAuthority(config);

/** Canonical protected-resource metadata URL advertised in 401 challenges. */
const RESOURCE_METADATA_URL = `${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource`;

const sessions = new McpSessionRegistry();
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function loadConfiguration(): McpHttpConfig {
  try {
    return loadMcpHttpConfig();
  } catch (error) {
    logError("Invalid MCP HTTP configuration", error);
    process.exit(1);
  }
}

const cleanupInterval = setInterval(() => {
  const cleaned = sessions.cleanupIdle(Date.now(), SESSION_IDLE_TIMEOUT_MS);
  if (cleaned > 0) {
    logInfo("Cleaned idle sessions", {
      cleanedSessions: cleaned,
      activeSessions: sessions.size,
    });
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

async function verifyUserToken(
  userToken: string,
): Promise<AuthenticatedMcpToken | undefined> {
  try {
    return (await authenticateMcpAccessToken(userToken, {
      config,
      introspectCentral: introspectCentralToken,
    })) ?? undefined;
  } catch (error) {
    logWarn("MCP token validation unavailable", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return undefined;
  }
}

function requestAuthContext(
  userToken: string,
  token: AuthenticatedMcpToken,
) {
  return {
    userToken,
    authMode: token.authMode,
    tokenId: token.jti,
    clientId: token.client_id,
    accountId: token.accountId,
    scopes: token.scopes,
  } as const;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const requestOrigin = Array.isArray(origin) ? origin[0] : origin;
  if (requestOrigin && config.allowedOrigins.has(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Idempotency-Key, Mcp-Session-Id",
  );
  // The client reads the session id assigned on `initialize` from the response;
  // it is invisible to browser fetch() unless explicitly exposed.
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, WWW-Authenticate, X-Request-Id",
  );
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
  const tokenClaims = userToken ? await verifyUserToken(userToken) : undefined;
  if (!userToken || !tokenClaims) {
    sendUnauthorized(res);
    return;
  }

  if (method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !(transport instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    if (!sessions.isAuthorized(sessionId, tokenClaims)) {
      sendUnauthorized(res);
      return;
    }
    sessions.touch(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  if (method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !(transport instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    if (!sessions.isAuthorized(sessionId, tokenClaims)) {
      sendUnauthorized(res);
      return;
    }
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
    return;
  }

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existingTransport = sessionId ? sessions.get(sessionId) : undefined;
    let transport: StreamableHTTPServerTransport;
    const body = await readBody(req);

    if (sessionId && existingTransport instanceof StreamableHTTPServerTransport) {
      if (!sessions.isAuthorized(sessionId, tokenClaims)) {
        sendUnauthorized(res);
        return;
      }
      transport = existingTransport;
      sessions.touch(sessionId);
    } else if (sessionId) {
      sendJsonRpcError(res, 404, -32001, "Session not found. Send an initialize request without a session ID.");
      return;
    } else {
      if (sessions.size >= MAX_SESSIONS) {
        sendJsonRpcError(res, 503, -32000, "MCP server is at its session capacity.");
        return;
      }
      const server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
    }

    await requestContext.run(requestAuthContext(userToken, tokenClaims), () =>
      transport.handleRequest(req, res, body),
    );

    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.register(
        transport.sessionId,
        transport,
        fingerprintMcpPrincipal(tokenClaims),
      );
      logInfo("Created MCP session", { activeSessions: sessions.size });
    }
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof BodyTooLargeError) {
        sendJsonRpcError(res, 413, -32000, error.message);
      } else if (error instanceof SyntaxError) {
        sendJsonRpcError(res, 400, -32700, "Invalid JSON request body.");
      } else {
        logError("MCP request failed", error);
        sendJsonRpcError(res, 500, -32603, "Internal server error.");
      }
    }
  }
}

async function main() {
  const { createServer } = await import("node:http");

  const httpServer = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    res.setHeader("X-Request-Id", requestId);
    res.once("finish", () => {
      logInfo("HTTP request completed", {
        requestId,
        method: req.method ?? "UNKNOWN",
        route: normalizedRoute(pathname),
        statusCode: res.statusCode,
        durationMs: Math.round((performance.now() - requestStartedAt) * 100) / 100,
      });
    });

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
      res.end(JSON.stringify(buildProtectedResourceMetadata({
        resource: MCP_PUBLIC_URL,
        authorizationServer: OAUTH_AS_URL,
        scopes: MENTION_MCP_CAPABILITIES,
      })));
      return;
    }

    if (pathname.startsWith("/_oxy/capabilities/")) {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 400;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(status);
        res.end(JSON.stringify({
          error: error instanceof BodyTooLargeError
            ? "capability_request_too_large"
            : "invalid_capability_json",
        }));
        return;
      }
      const result = await handleMentionCapabilityRequest({
        method: req.method ?? "",
        pathname,
        authorization: typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : undefined,
        idempotencyKey: typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
        body,
      }, capabilityAuthority);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
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
      const tokenClaims = userToken ? await verifyUserToken(userToken) : undefined;
      if (!userToken || !tokenClaims) {
        sendUnauthorized(res);
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        sendJsonRpcError(res, 503, -32000, "MCP server is at its session capacity.");
        return;
      }
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      setLegacyTransportHeaders(res);
      sessions.register(
        transport.sessionId,
        transport,
        fingerprintMcpPrincipal(tokenClaims),
      );
      logWarn("Legacy SSE session created", {
        activeSessions: sessions.size,
      });
      res.on("close", () => {
        sessions.delete(transport.sessionId);
      });
      await server.connect(transport);
      return;
    }

    if (pathname === "/messages" && req.method === "POST") {
      setLegacyTransportHeaders(res);
      const userToken = extractBearerToken(headers);
      const tokenClaims = userToken ? await verifyUserToken(userToken) : undefined;
      if (!userToken || !tokenClaims) {
        sendUnauthorized(res);
        return;
      }
      const sessionId = query.sessionId;
      const transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        sendJsonRpcError(res, 400, -32000, "No active SSE session. Connect via GET /sse first.");
        return;
      }
      if (!sessionId || !sessions.isAuthorized(sessionId, tokenClaims)) {
        sendUnauthorized(res);
        return;
      }

      try {
        const body = await readBody(req);
        await requestContext.run(requestAuthContext(userToken, tokenClaims), () =>
          transport.handlePostMessage(req, res, body),
        );
      } catch (error) {
        if (!res.headersSent) {
          if (error instanceof BodyTooLargeError) {
            sendJsonRpcError(res, 413, -32000, error.message);
          } else if (error instanceof SyntaxError) {
            sendJsonRpcError(res, 400, -32700, "Invalid JSON request body.");
          } else {
            logError("Legacy SSE request failed", error, { requestId });
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
      logError("Unhandled HTTP request failure", error);
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
    logInfo(`Listening on :${listeningPort}`, {
      publicUrl: MCP_PUBLIC_URL,
      transport: ["streamable-http", "sse"],
    });
  });

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logInfo("Shutdown started", {
      signal,
      activeSessions: sessions.size,
    });
    clearInterval(cleanupInterval);

    const forceExit = setTimeout(() => {
      logError("Graceful shutdown timed out");
      httpServer.closeAllConnections?.();
      process.exit(1);
    }, 10_000);

    const serverClosed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await sessions.closeAll();
    httpServer.closeIdleConnections?.();
    await serverClosed;
    clearTimeout(forceExit);
    logInfo("Shutdown complete");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logError("Fatal startup error", error);
  process.exit(1);
});

function normalizedRoute(pathname: string): string {
  if (pathname === "/" || pathname === "/mcp") return "/mcp";
  if (pathname === "/sse" || pathname === "/messages") return "/legacy-sse";
  if (pathname === "/health") return "/health";
  if (pathname === "/.well-known/oauth-protected-resource") {
    return "/.well-known/oauth-protected-resource";
  }
  if (pathname.startsWith("/_oxy/capabilities/")) return "/_oxy/capabilities/:tool";
  return "unmatched";
}

function setLegacyTransportHeaders(res: ServerResponse): void {
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Warning",
    '299 Mention "Legacy SSE transport is deprecated; use Streamable HTTP at /mcp"',
  );
}
