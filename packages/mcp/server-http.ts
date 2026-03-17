/**
 * Mention MCP Server — HTTP/SSE transport
 *
 * Supports both:
 *   1. Streamable HTTP (protocol 2025-11-25) on POST/GET/DELETE /mcp
 *   2. SSE (protocol 2024-11-05) on GET /sse + POST /messages
 *
 * Environment variables:
 *   MENTION_API_URL   — Base URL of the Mention API (default: https://api.mention.earth)
 *   OXY_SERVICE_TOKEN — Service-level Oxy JWT (fallback when no user token)
 *   MCP_PORT          — Port to listen on (default: 3100)
 *   MCP_AUTH_TOKEN    — Optional token to protect the MCP endpoint (X-MCP-Token header)
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerPostsTools } from "./tools/posts.js";
import { registerFeedTools } from "./tools/feed.js";
import { registerInteractionsTools } from "./tools/interactions.js";
import { registerSearchTools } from "./tools/search.js";
import { registerListsTools } from "./tools/lists.js";
import { registerNotificationsTools } from "./tools/notifications.js";
import { registerPollsTools } from "./tools/polls.js";
import { registerHashtagsTools } from "./tools/hashtags.js";
import { SERVER_INSTRUCTIONS } from "./lib/instructions.js";
import { requestContext } from "./lib/context.js";

const PORT = parseInt(process.env.MCP_PORT || "3100", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// ── Transport store ──────────────────────────────────────────
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
const sessionLastActivity: Map<string, number> = new Map();

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Clean up idle sessions every 10 minutes
setInterval(() => {
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

// ── Auth ─────────────────────────────────────────────────────
interface SimpleRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

interface SimpleResponse {
  status(code: number): SimpleResponse;
  json(body: unknown): void;
  headersSent?: boolean;
  on?(event: string, handler: () => void): void;
}

function extractBearerToken(req: SimpleRequest): string | undefined {
  const authHeader = req.headers.authorization;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const queryToken = req.query?.token;
  return Array.isArray(queryToken) ? queryToken[0] : queryToken;
}

/**
 * Check endpoint protection. If MCP_AUTH_TOKEN is set, the request must
 * include it as an X-MCP-Token header or ?mcp_token query param.
 * The Bearer token is reserved for the user's Oxy JWT (forwarded to the API).
 */
function checkEndpointAuth(req: SimpleRequest, res: SimpleResponse): boolean {
  if (!AUTH_TOKEN) return true;
  const mcpToken =
    (Array.isArray(req.headers["x-mcp-token"]) ? req.headers["x-mcp-token"][0] : req.headers["x-mcp-token"]) ||
    (Array.isArray(req.query?.mcp_token) ? req.query?.mcp_token[0] : req.query?.mcp_token);
  if (mcpToken === AUTH_TOKEN) return true;
  // Also accept Bearer token matching MCP_AUTH_TOKEN for backward compatibility
  const bearer = extractBearerToken(req);
  if (bearer === AUTH_TOKEN) return true;
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized: Invalid or missing auth token" },
    id: null,
  });
  return false;
}

/** Map session IDs to their user tokens for SSE sessions (long-lived). */
const sessionUserTokens: Map<string, string> = new Map();

// ── Create MCP server ────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "mention", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerPostsTools(server);
  registerFeedTools(server);
  registerInteractionsTools(server);
  registerSearchTools(server);
  registerListsTools(server);
  registerNotificationsTools(server);
  registerPollsTools(server);
  registerHashtagsTools(server);

  return server;
}

async function main() {
  // Use Bun.serve or fall back to a simple HTTP server
  // We use the express-like API from MCP SDK if available, otherwise raw HTTP
  const { createServer } = await import("node:http");

  const httpServer = createServer(async (req, res) => {
    // Parse URL
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Parse query params
    const query: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Helper to read JSON body
    const readBody = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
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

    // Helper response wrapper
    const simpleReq: SimpleRequest = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      query,
    };
    const simpleRes: SimpleResponse = {
      status(code: number) {
        res.statusCode = code;
        return this;
      },
      json(body: unknown) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      },
    };

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
      if (!checkEndpointAuth(simpleReq, simpleRes)) return;
      const userToken = extractBearerToken(simpleReq);
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
          transport = transports[sessionId] as StreamableHTTPServerTransport;
          sessionLastActivity.set(sessionId, Date.now());
        } else if (sessionId) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(404);
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found. Send an initialize request without a session ID." },
            id: null,
          }));
          return;
        } else {
          const server = createMcpServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
              sessionLastActivity.delete(transport.sessionId);
              sessionUserTokens.delete(transport.sessionId);
            }
          };
          await server.connect(transport);
        }

        const body = await readBody();
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
          res.setHeader("Content-Type", "application/json");
          res.writeHead(500);
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` },
            id: null,
          }));
        }
      }
      return;
    }

    // ── Streamable HTTP: GET /mcp ────────────────────────────
    if (pathname === "/mcp" && req.method === "GET") {
      if (!checkEndpointAuth(simpleReq, simpleRes)) return;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !(transports[sessionId] instanceof StreamableHTTPServerTransport)) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(404);
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found." },
          id: null,
        }));
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      const transport = transports[sessionId] as StreamableHTTPServerTransport;
      await transport.handleRequest(req, res);
      return;
    }

    // ── Streamable HTTP: DELETE /mcp ─────────────────────────
    if (pathname === "/mcp" && req.method === "DELETE") {
      if (!checkEndpointAuth(simpleReq, simpleRes)) return;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !(transports[sessionId] instanceof StreamableHTTPServerTransport)) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(404);
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found." },
          id: null,
        }));
        return;
      }
      const transport = transports[sessionId] as StreamableHTTPServerTransport;
      await transport.handleRequest(req, res);
      delete transports[sessionId];
      sessionLastActivity.delete(sessionId);
      sessionUserTokens.delete(sessionId);
      return;
    }

    // ── SSE: GET /sse ────────────────────────────────────────
    if (pathname === "/sse" && req.method === "GET") {
      if (!checkEndpointAuth(simpleReq, simpleRes)) return;
      const userToken = extractBearerToken(simpleReq);
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      if (userToken) {
        sessionUserTokens.set(transport.sessionId, userToken);
      }

      res.on("close", () => {
        delete transports[transport.sessionId];
        sessionLastActivity.delete(transport.sessionId);
        sessionUserTokens.delete(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    // ── SSE: POST /messages ──────────────────────────────────
    if (pathname === "/messages" && req.method === "POST") {
      if (!checkEndpointAuth(simpleReq, simpleRes)) return;
      const sessionId = query.sessionId;
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No active SSE session. Connect via GET /sse first." },
          id: null,
        }));
        return;
      }

      // Use per-request Bearer token, or fall back to the token from session init
      const userToken = extractBearerToken(simpleReq) || (sessionId ? sessionUserTokens.get(sessionId) : undefined);
      const body = await readBody();
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
║  Auth: ${AUTH_TOKEN ? "Enabled (Bearer token)" : "Disabled (open access)       "}║
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
    for (const [id, transport] of Object.entries(transports)) {
      transport.close();
      delete transports[id];
      sessionLastActivity.delete(id);
      sessionUserTokens.delete(id);
    }
    httpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[mention-mcp-http] Fatal error:", error);
  process.exit(1);
});
