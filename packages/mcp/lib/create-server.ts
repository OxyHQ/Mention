/**
 * Shared MCP server factory used by the HTTP transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MENTION_TOOL_REGISTRY } from "./mention-catalog.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "mention", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  MENTION_TOOL_REGISTRY.registerWithMcp(server);

  return server;
}
