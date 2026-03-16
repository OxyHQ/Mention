import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatFeed } from "../lib/formatters.js";

export function registerHashtagsTools(server: McpServer): void {
  // ── get-trending-hashtags ────────────────────────────────────
  server.tool(
    "get-trending-hashtags",
    "Get currently trending hashtags on Mention.",
    {
      limit: z.number().optional().describe("Number of hashtags to return (default: 10)"),
    },
    async ({ limit }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;

        const result = await api.get("/trending", query);
        const resultObj = result as Record<string, unknown>;
        const hashtags = Array.isArray(resultObj.hashtags)
          ? resultObj.hashtags
          : Array.isArray(result)
            ? result
            : [];

        if (hashtags.length === 0) {
          return { content: [{ type: "text" as const, text: "No trending hashtags right now." }] };
        }

        const lines = hashtags.map((h: Record<string, unknown>, i: number) => {
          const name = h.name || h.hashtag || h.tag || "unknown";
          const count = h.count || h.postCount || h.tweetCount || 0;
          return `${i + 1}. #${name} (${count} posts)`;
        });

        return { content: [{ type: "text" as const, text: `Trending hashtags:\n\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── get-posts-by-hashtag ─────────────────────────────────────
  server.tool(
    "get-posts-by-hashtag",
    "Get posts tagged with a specific hashtag.",
    {
      hashtag: z.string().describe("The hashtag to search for (without # prefix)"),
      limit: z.number().optional().describe("Number of posts (default: 20, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ hashtag, limit, cursor }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (cursor) query.cursor = cursor;

        const result = await api.get(`/posts/hashtag/${encodeURIComponent(hashtag)}`, query);
        return { content: [{ type: "text" as const, text: formatFeed(result as Record<string, unknown>) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
