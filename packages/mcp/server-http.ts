/**
 * Mention MCP Server — HTTP/SSE transport
 *
 * Supports both:
 *   1. Streamable HTTP (protocol 2025-11-25) on POST/GET/DELETE /mcp
 *   2. SSE (protocol 2024-11-05) on GET /sse + POST /messages
 *
 * Environment variables:
 *   MENTION_API_URL — Base URL of the Mention API (default: https://api.mention.earth)
 *   MCP_PORT        — Port to listen on (default: 3100)
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./lib/create-server.js";
import { requestContext } from "./lib/context.js";

const PORT = parseInt(process.env.MCP_PORT || "3100", 10);

// ── Transport store ──────────────────────────────────────────
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
const sessionLastActivity: Map<string, number> = new Map();
/** Map session IDs to their user tokens for SSE sessions (long-lived). */
const sessionUserTokens: Map<string, string> = new Map();

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Clean up idle sessions every 10 minutes
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
      sessionUserTokens.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[mention-mcp-http] Cleaned ${cleaned} idle sessions (${Object.keys(transports).length} active)`);
  }
}, 10 * 60 * 1000);
cleanupInterval.unref();

// ── Helpers ──────────────────────────────────────────────────

function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
  query?: Record<string, string | undefined>,
): string | undefined {
  const authHeader = headers.authorization;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const queryToken = query?.token;
  return Array.isArray(queryToken) ? queryToken[0] : queryToken;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(httpStatus);
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  }));
}

function cleanupSession(id: string): void {
  delete transports[id];
  sessionLastActivity.delete(id);
  sessionUserTokens.delete(id);
}

// ── Main ─────────────────────────────────────────────────────

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

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Health check ─────────────────────────────────────────
    if (pathname === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", server: "mention-mcp", transport: ["streamable-http", "sse"] }));
      return;
    }

    // ── OAuth discovery (return JSON 404 to prevent mcp-remote crashes) ──
    if (pathname.startsWith("/.well-known/oauth") || pathname === "/register") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(404);
      res.end(JSON.stringify({ error: "OAuth not supported" }));
      return;
    }

    // ── Streamable HTTP: POST /mcp ───────────────────────────
    if (pathname === "/mcp" && req.method === "POST") {
      const userToken = extractBearerToken(headers, query);
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
          sendJsonRpcError(res, 500, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    // ── Streamable HTTP: GET /mcp ────────────────────────────
    if (pathname === "/mcp" && req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !(transports[sessionId] instanceof StreamableHTTPServerTransport)) {
        sendJsonRpcError(res, 404, -32001, "Session not found.");
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      const transport = transports[sessionId] as StreamableHTTPServerTransport;
      await transport.handleRequest(req, res);
      return;
    }

    // ── Streamable HTTP: DELETE /mcp ─────────────────────────
    if (pathname === "/mcp" && req.method === "DELETE") {
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

    // ── SSE: GET /sse ────────────────────────────────────────
    if (pathname === "/sse" && req.method === "GET") {
      const userToken = extractBearerToken(headers, query);
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      if (userToken) {
        sessionUserTokens.set(transport.sessionId, userToken);
      }

      res.on("close", () => {
        cleanupSession(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    // ── SSE: POST /messages ──────────────────────────────────
    if (pathname === "/messages" && req.method === "POST") {
      const sessionId = query.sessionId;
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        sendJsonRpcError(res, 400, -32000, "No active SSE session. Connect via GET /sse first.");
        return;
      }

      // Use per-request Bearer token, or fall back to the token from session init
      const userToken = extractBearerToken(headers, query) || (sessionId ? sessionUserTokens.get(sessionId) : undefined);
      const body = await readBody(req);
      await requestContext.run({ userToken }, () =>
        transport.handlePostMessage(req, res, body),
      );
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║  Mention MCP Server (HTTP/SSE)                   ║
║  Port: ${String(PORT).padEnd(41)}║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║  • POST/GET/DELETE /mcp  (Streamable HTTP)       ║
║  • GET /sse + POST /messages  (SSE)              ║
║  • GET /health  (Health check)                   ║
╚══════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[mention-mcp-http] Shutting down...");
    const closePromises: Promise<void>[] = [];
    for (const [id, transport] of Object.entries(transports)) {
      closePromises.push(
        Promise.resolve(transport.close()).catch(() => {}),
      );
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
