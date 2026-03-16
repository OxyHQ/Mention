import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { formatPost } from "../lib/formatters.js";

export function registerInteractionsTools(server: McpServer): void {
  // ── like-post ────────────────────────────────────────────────
  server.tool(
    "like-post",
    "Like a post.",
    {
      id: z.string().describe("The post ID to like"),
    },
    async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: "text" as const, text: `Post ${id} liked.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── unlike-post ──────────────────────────────────────────────
  server.tool(
    "unlike-post",
    "Remove your like from a post.",
    {
      id: z.string().describe("The post ID to unlike"),
    },
    async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: "text" as const, text: `Post ${id} unliked.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── save-post ────────────────────────────────────────────────
  server.tool(
    "save-post",
    "Bookmark/save a post.",
    {
      id: z.string().describe("The post ID to save"),
    },
    async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: "text" as const, text: `Post ${id} saved to bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── unsave-post ──────────────────────────────────────────────
  server.tool(
    "unsave-post",
    "Remove a post from your bookmarks.",
    {
      id: z.string().describe("The post ID to unsave"),
    },
    async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: "text" as const, text: `Post ${id} removed from bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── repost ───────────────────────────────────────────────────
  server.tool(
    "repost",
    "Repost (share) someone else's post to your followers.",
    {
      id: z.string().describe("The post ID to repost"),
    },
    async ({ id }) => {
      try {
        const result = await api.post(`/posts/${encodeURIComponent(id)}/repost`);
        return { content: [{ type: "text" as const, text: `Post ${id} reposted.\n\n${formatPost(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  // ── quote-post ───────────────────────────────────────────────
  server.tool(
    "quote-post",
    "Quote a post with your own commentary.",
    {
      id: z.string().describe("The post ID to quote"),
      text: z.string().describe("Your commentary text"),
    },
    async ({ id, text }) => {
      try {
        const result = await api.post(`/posts/${encodeURIComponent(id)}/quote`, { content: { text } });
        return { content: [{ type: "text" as const, text: `Quote post created.\n\n${formatPost(result as Record<string, unknown>)}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
