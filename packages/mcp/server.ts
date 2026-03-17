/**
 * Mention MCP Server — stdio transport
 *
 * Usage:
 *   MENTION_API_URL=https://api.mention.earth OXY_SERVICE_TOKEN=<jwt> bun server.ts
 *
 * Environment variables:
 *   MENTION_API_URL   — Base URL of the Mention API (default: https://api.mention.earth)
 *   OXY_SERVICE_TOKEN — Oxy JWT for authenticating API requests
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPostsTools } from "./tools/posts.js";
import { registerFeedTools } from "./tools/feed.js";
import { registerInteractionsTools } from "./tools/interactions.js";
import { registerSearchTools } from "./tools/search.js";
import { registerListsTools } from "./tools/lists.js";
import { registerNotificationsTools } from "./tools/notifications.js";
import { registerPollsTools } from "./tools/polls.js";
import { registerHashtagsTools } from "./tools/hashtags.js";
import { SERVER_INSTRUCTIONS } from "./lib/instructions.js";

async function main() {
  // Redirect console to stderr so it doesn't interfere with stdio transport
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => process.stderr.write(`[mention-mcp] ${args.join(" ")}\n`);
  console.warn = (...args: unknown[]) => process.stderr.write(`[mention-mcp] WARN: ${args.join(" ")}\n`);

  const server = new McpServer(
    { name: "mention", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Register all tool groups
  registerPostsTools(server);
  registerFeedTools(server);
  registerInteractionsTools(server);
  registerSearchTools(server);
  registerListsTools(server);
  registerNotificationsTools(server);
  registerPollsTools(server);
  registerHashtagsTools(server);

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
