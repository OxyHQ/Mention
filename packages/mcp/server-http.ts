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
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./lib/create-server.js";
import { requestContext } from "./lib/context.js";

const PORT = parseInt(process.env.MCP_PORT || "3100", 10);
const MAX_REQUEST_BODY_BYTES = parseInt(process.env.MCP_MAX_REQUEST_BODY_BYTES || "1048576", 10);
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

const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
const sessionLastActivity: Map<string, number> = new Map();
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  let cleaned = 0;
  const now = Date.now();
  for (const [id, transport] of Object.entries(transports)) {
    if (transport instanceof SSEServerTransport) continue;
    const lastActivity = sessionLastActivity.get(id) ?? 0;
    if (now - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      transport.close().catch(() => {});
      delete transports[id];
      sessionLastActivity.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[mention-mcp-http] Cleaned ${cleaned} idle sessions (${Object.keys(transports).length} active)`);
  }
}, 10 * 60 * 1000);
cleanupInterval.unref();

function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const authHeader = headers.authorization;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return undefined;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
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
  res.setHeader("Content-Type", "application/json");
  res.writeHead(401);
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authentication required." },
    id: null,
  }));
}

function cleanupSession(id: string): void {
  delete transports[id];
  sessionLastActivity.delete(id);
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

  if (method === "GET") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    // An unauthenticated GET (no session, no bearer token) is the client's
    // discovery probe — answer with a 401 OAuth challenge, NOT a 404, so the
    // client can find the protected-resource metadata and start the OAuth flow.
    if (!sessionId && !userToken) {
      sendUnauthorized(res);
      return;
    }
    if (!sessionId || !(transports[sessionId] instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    sessionLastActivity.set(sessionId, Date.now());
    const transport = transports[sessionId] as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
    return;
  }

  if (method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !(transports[sessionId] instanceof StreamableHTTPServerTransport)) {
      sendJsonRpcError(res, 404, -32001, "Session not found.");
      return;
    }
    const transport = transports[sessionId] as StreamableHTTPServerTransport;
    await transport.handleRequest(req, res);
    cleanupSession(sessionId);
    return;
  }

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      transport = transports[sessionId] as StreamableHTTPServerTransport;
      sessionLastActivity.set(sessionId, Date.now());
    } else if (sessionId) {
      sendJsonRpcError(res, 404, -32001, "Session not found. Send an initialize request without a session ID.");
      return;
    } else {
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

    const body = await readBody(req);
    await requestContext.run({ userToken }, () =>
      transport.handleRequest(req, res, body),
    );

    if (transport.sessionId && !transports[transport.sessionId]) {
      transports[transport.sessionId] = transport;
      sessionLastActivity.set(transport.sessionId, Date.now());
      console.log(`[mention-mcp-http] New session: ${transport.sessionId}`);
    }
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof BodyTooLargeError) {
        sendJsonRpcError(res, 413, -32000, error.message);
      } else {
        sendJsonRpcError(res, 500, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function main() {
  const { createServer } = await import("node:http");

  const httpServer = createServer(async (req, res) => {
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
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        cleanupSession(transport.sessionId);
      });
      await server.connect(transport);
      return;
    }

    if (pathname === "/messages" && req.method === "POST") {
      const sessionId = query.sessionId;
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        sendJsonRpcError(res, 400, -32000, "No active SSE session. Connect via GET /sse first.");
        return;
      }

      const userToken = extractBearerToken(headers);
      try {
        const body = await readBody(req);
        await requestContext.run({ userToken }, () =>
          transport.handlePostMessage(req, res, body),
        );
      } catch (error) {
        if (!res.headersSent) {
          if (error instanceof BodyTooLargeError) {
            sendJsonRpcError(res, 413, -32000, error.message);
          } else {
            sendJsonRpcError(res, 500, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[mention-mcp-http] Listening on :${PORT} — public URL ${MCP_PUBLIC_URL}/`);
  });

  process.on("SIGINT", () => {
    console.log("\n[mention-mcp-http] Shutting down...");
    const closePromises: Promise<void>[] = [];
    for (const [id, transport] of Object.entries(transports)) {
      closePromises.push(Promise.resolve(transport.close()).catch(() => {}));
      cleanupSession(id);
    }
    Promise.allSettled(closePromises).then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error("[mention-mcp-http] Fatal error:", error);
  process.exit(1);
});
