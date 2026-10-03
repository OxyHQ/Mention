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
 *   MCP_MAX_SESSIONS             — Max open legacy SSE sessions per task (default: 1000)
 *   MENTION_MCP_JWT_SECRET       — Shared HS256 secret (required)
 */
import { startPlatformActivity } from './lib/platform-activity.js';
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  buildProtectedResourceMetadata,
  extractBearerToken,
} from "@oxy.so/mcp";
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
import { resolveMcpSession } from "./lib/mcp-session.js";
import { McpSessionRegistry } from "./lib/session-registry.js";
import {
  authenticateMcpAccessToken,
  createCentralTokenIntrospector,
} from "./lib/token-authenticator.js";
import { createMentionCapabilityAuthority } from "./lib/capability-authority.js";
import { handleMentionCapabilityRequest } from "./lib/capability-http.js";

import { createMentionInternalMcp } from './lib/internal-capability-mcp.js';

const config = loadConfiguration();
const PORT = config.port;
const MAX_REQUEST_BODY_BYTES = config.maxRequestBodyBytes;
const MAX_SESSIONS = config.maxSessions;
const MCP_PUBLIC_URL = config.publicUrl;
const OAUTH_AS_URL = config.oxyApiUrl;
const introspectCentralToken = createCentralTokenIntrospector(config);
const capabilityAuthority = createMentionCapabilityAuthority(config);
const internalMcp = createMentionInternalMcp(config);

/** Canonical protected-resource metadata URL advertised in 401 challenges. */
const RESOURCE_METADATA_URL = `${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource`;

/**
 * Legacy `/sse` + `/messages` sessions only. That transport is stateful by
 * construction — the response stream opened by `GET /sse` lives in one process
 * and `POST /messages` must reach it — so it still works only while a client's
 * requests reach the same task. Streamable HTTP at `/mcp` keeps no state here.
 */
const legacySseSessions = new McpSessionRegistry();

function loadConfiguration(): McpHttpConfig {
  try {
    return loadMcpHttpConfig();
  } catch (error) {
    logError("Invalid MCP HTTP configuration", error);
    process.exit(1);
  }
}

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

/**
 * What checking a bearer token came to. `unavailable` is NOT `invalid`: it means
 * this server could not ask Oxy (its own service identity was refused, Oxy was
 * down, the network failed), which says nothing about the caller's token.
 */
type TokenCheck =
  | { readonly status: "valid"; readonly token: AuthenticatedMcpToken }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

async function checkUserToken(userToken: string | undefined): Promise<TokenCheck> {
  if (!userToken) return { status: "invalid" };
  try {
    const token = await authenticateMcpAccessToken(userToken, {
      config,
      introspectCentral: introspectCentralToken,
    });
    return token ? { status: "valid", token } : { status: "invalid" };
  } catch (error) {
    logWarn("MCP token validation unavailable", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { status: "unavailable" };
  }
}

/**
 * Answer a request whose token could not be CHECKED with 503, never 401.
 *
 * A 401 tells an MCP client its grant is bad, and a client (Claude, ChatGPT,
 * an automation) reacts by discarding it and asking its person to sign in
 * again. On 2026-09-25 Oxy refused this server's workload attestation for half
 * an hour and every connected client was told to re-authorize — for a fault
 * that was entirely on this side. `Retry-After` tells them to simply try again.
 */
function sendValidationUnavailable(res: ServerResponse): void {
  res.setHeader("Retry-After", "30");
  res.setHeader("Cache-Control", "no-store");
  sendJsonRpcError(res, 503, -32000, "Token validation is temporarily unavailable. Retry shortly.");
}

/** Answers the request itself unless the token checked out; returns the token when it did. */
function requireValidToken(check: TokenCheck, res: ServerResponse): AuthenticatedMcpToken | undefined {
  if (check.status === "valid") return check.token;
  if (check.status === "unavailable") sendValidationUnavailable(res);
  else sendUnauthorized(res);
  return undefined;
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

/**
 * Streamable HTTP at `/mcp`, served STATELESSLY: each POST gets a fresh server
 * and transport and is answered from the request alone, so any task behind the
 * load balancer can serve any request. A deploy rollover or a scale-out runs
 * two tasks at once, and the ALB round-robins between them without cookies (MCP
 * clients do not keep them); a session held in one task's memory was a 404 on
 * the other for every client, for the whole rollover.
 *
 * What a session used to hold, and where it comes from now:
 * - identity, account and capabilities: the bearer token, introspected live on
 *   every request, exactly as before;
 * - the active account of a multi-account connection: Oxy's introspection and
 *   Mention's API, never this process;
 * - the effect idempotency namespace: the `Mcp-Session-Id` the client echoes.
 *   This server issues it on `initialize` and accepts it on any task without a
 *   lookup (see `lib/mcp-session.ts`);
 * - server-initiated messages: there are none. The tool list is static and no
 *   tool notifies or calls the client, so there is no GET stream to keep.
 */
async function handleStreamableMcp(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string | string[] | undefined>,
  method: "POST" | "GET" | "DELETE",
): Promise<void> {
  const userToken = extractBearerToken(headers);
  const tokenClaims = requireValidToken(await checkUserToken(userToken), res);
  if (!userToken || !tokenClaims) return;

  if (method !== "POST") {
    // GET would open a stream for server-initiated messages and DELETE would end
    // a session; a stateless server has neither. The spec's answer for both is
    // 405, which MCP clients treat as "not offered", never as a lost session.
    res.setHeader("Allow", "POST, OPTIONS");
    sendJsonRpcError(
      res,
      405,
      -32000,
      "Method not allowed. This MCP server is stateless: POST JSON-RPC messages to /mcp.",
    );
    return;
  }

  try {
    const body = await readBody(req);
    const session = resolveMcpSession(body, req.headers["mcp-session-id"]);
    if (!session.ok) {
      sendJsonRpcError(res, 400, -32000, session.message);
      return;
    }

    // One server and one transport per request, as the SDK requires of a
    // stateless transport. Building the server registers the static tool
    // catalogue, a fraction of a millisecond.
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.once("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);

    if (session.issued) {
      res.setHeader("Mcp-Session-Id", session.id);
      logInfo("Issued MCP session id");
    }
    await requestContext.run(
      { ...requestAuthContext(userToken, tokenClaims), sessionId: session.id },
      () => transport.handleRequest(req, res, body),
    );
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

  let listening = false;
  const activity = startPlatformActivity(() => listening);
  const httpServer = createServer((req, res) => {
    activity?.observeHttp(req, res, () => {});
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

    if (pathname === "/_oxy/mcp") {
      if (!internalMcp) { sendJsonRpcError(res, 503, -32000, "Internal MCP catalogue binding is not configured."); return; }
      await internalMcp.handleMcp(req, res);
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
      const tokenClaims = requireValidToken(await checkUserToken(userToken), res);
      if (!userToken || !tokenClaims) return;
      if (legacySseSessions.size >= MAX_SESSIONS) {
        sendJsonRpcError(res, 503, -32000, "MCP server is at its session capacity.");
        return;
      }
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      setLegacyTransportHeaders(res);
      legacySseSessions.register(
        transport.sessionId,
        transport,
        fingerprintMcpPrincipal(tokenClaims),
      );
      logWarn("Legacy SSE session created", {
        activeSessions: legacySseSessions.size,
      });
      res.on("close", () => {
        legacySseSessions.delete(transport.sessionId);
      });
      await server.connect(transport);
      return;
    }

    if (pathname === "/messages" && req.method === "POST") {
      setLegacyTransportHeaders(res);
      const userToken = extractBearerToken(headers);
      const tokenClaims = requireValidToken(await checkUserToken(userToken), res);
      if (!userToken || !tokenClaims) return;
      const sessionId = query.sessionId;
      const transport = sessionId ? legacySseSessions.get(sessionId) : undefined;

      if (!sessionId || !transport) {
        sendJsonRpcError(res, 400, -32000, "No active SSE session. Connect via GET /sse first.");
        return;
      }
      if (!legacySseSessions.isAuthorized(sessionId, tokenClaims)) {
        sendUnauthorized(res);
        return;
      }

      try {
        const body = await readBody(req);
        await requestContext.run(
          { ...requestAuthContext(userToken, tokenClaims), sessionId },
          () => transport.handlePostMessage(req, res, body),
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
    listening = true;
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
    listening = false;
    logInfo("Shutdown started", {
      signal,
      activeLegacySseSessions: legacySseSessions.size,
    });

    const forceExit = setTimeout(() => {
      logError("Graceful shutdown timed out");
      httpServer.closeAllConnections?.();
      process.exit(1);
    }, 10_000);

    const serverClosed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await legacySseSessions.closeAll();
    httpServer.closeIdleConnections?.();
    await serverClosed;
    await activity?.stop();
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
  if (pathname === "/_oxy/mcp") return "/_oxy/mcp";
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
