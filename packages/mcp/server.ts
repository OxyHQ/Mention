/**
 * Mention MCP Server — stdio transport
 *
 * Usage:
 *   MENTION_API_URL=https://api.mention.earth bun server.ts
 *
 * Environment variables:
 *   MENTION_API_URL — Base URL of the Mention API (default: https://api.mention.earth)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/create-server.js";

async function main() {
  // Redirect console to stderr so it doesn't interfere with stdio transport
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => process.stderr.write(`[mention-mcp] ${args.join(" ")}\n`);
  console.warn = (...args: unknown[]) => process.stderr.write(`[mention-mcp] WARN: ${args.join(" ")}\n`);

  const server = createMcpServer();

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[mention-mcp] MCP server running on stdio.\n");

  // Restore console
  console.log = originalLog;
  console.warn = originalWarn;
}

main().catch((error) => {
  process.stderr.write(`[mention-mcp] Fatal error: ${error}\n`);
  process.exit(1);
});
