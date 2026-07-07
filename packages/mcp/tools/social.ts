import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";

export function registerSocialTools(server: McpServer): void {
  server.tool(
    "follow-user",
    "Follow a user or federated actor (requires authorization). Pass actorUri (ActivityPub URI or acct handle like user@domain.com).",
    {
      actorUri: z.string().describe("Remote actor URI or acct handle to follow"),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        const result = await api.post("/federation/follow", { actorUri });
        const obj = result as Record<string, unknown>;
        const pending = obj.pending === true ? " (pending approval)" : "";
        return {
          content: [{
            type: "text" as const,
            text: `Follow request sent for ${actorUri}${pending}.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "unfollow-user",
    "Unfollow a user or federated actor (requires authorization).",
    {
      actorUri: z.string().describe("Remote actor URI or acct handle to unfollow"),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        await api.post("/federation/unfollow", { actorUri });
        return { content: [{ type: "text" as const, text: `Unfollowed ${actorUri}.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
