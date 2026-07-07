import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";

export function registerProfileTools(server: McpServer): void {
  server.tool(
    "get-profile",
    "Get public profile design data for a Mention user by Oxy user ID.",
    {
      userId: z.string().describe("Oxy user ID"),
    },
    async ({ userId }) => {
      try {
        const result = await api.get(`/profile/design/${encodeURIComponent(userId)}`);
        const profile = result as Record<string, unknown>;
        const handle = profile.username || profile.handle || "unknown";
        const displayName = profile.displayName || profile.name || handle;
        const bio = profile.bio || profile.description || "";
        const countBlock = profile._count as Record<string, unknown> | undefined;
        const followers = profile.followersCount ?? countBlock?.followers ?? "?";
        const following = profile.followingCount ?? countBlock?.following ?? "?";

        const lines = [
          `Profile: @${handle}`,
          `Name: ${displayName}`,
          `User ID: ${userId}`,
          `Followers: ${followers} | Following: ${following}`,
        ];
        if (bio) lines.push(`Bio: ${bio}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
