import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";
import { fetchMtnFeed } from "../lib/mtn-feed.js";
import { formatFeed } from "../lib/formatters.js";

export function registerHashtagsTools(server: McpServer): void {
  server.tool(
    "get-trending-hashtags",
    "Get currently trending hashtags and topics on Mention (public).",
    {
      limit: z.number().optional().describe("Number of items to return (default: 20)"),
    },
    async ({ limit }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = { type: "hashtag" };
        if (limit) query.limit = limit;

        const result = await api.get("/trending", query);
        const resultObj = result as Record<string, unknown>;
        const trending = Array.isArray(resultObj.trending) ? resultObj.trending : [];

        if (trending.length === 0) {
          return { content: [{ type: "text" as const, text: "No trending hashtags right now." }] };
        }

        const lines = trending.map((h: Record<string, unknown>, i: number) => {
          const name = h.name || h.hashtag || h.tag || h.label || "unknown";
          const count = h.count || h.postCount || h.score || 0;
          return `${i + 1}. #${String(name).replace(/^#/, "")} (${count})`;
        });

        return { content: [{ type: "text" as const, text: `Trending hashtags:\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get-posts-by-hashtag",
    "Get public posts tagged with a specific hashtag.",
    {
      hashtag: z.string().describe("The hashtag to search for (without # prefix)"),
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ hashtag, limit, cursor }) => {
      try {
        const tag = hashtag.replace(/^#/, "");
        const result = await fetchMtnFeed(`hashtag|${tag}`, { limit, cursor });
        return { content: [{ type: "text" as const, text: formatFeed(result) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
