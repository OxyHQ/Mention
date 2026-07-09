/**
 * Shared MCP server factory used by the HTTP transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPostsTools } from "../tools/posts.js";
import { registerFeedTools } from "../tools/feed.js";
import { registerInteractionsTools } from "../tools/interactions.js";
import { registerSearchTools } from "../tools/search.js";
import { registerListsTools } from "../tools/lists.js";
import { registerNotificationsTools } from "../tools/notifications.js";
import { registerPollsTools } from "../tools/polls.js";
import { registerHashtagsTools } from "../tools/hashtags.js";
import { registerProfileTools } from "../tools/profile.js";
import { registerSocialTools } from "../tools/social.js";
import { registerStarterPackTools } from "../tools/starter-packs.js";
import { registerAccountTools } from "../tools/accounts.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

export function createMcpServer(): McpServer {
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
  registerProfileTools(server);
  registerSocialTools(server);
  registerStarterPackTools(server);
  registerAccountTools(server);

  return server;
}
